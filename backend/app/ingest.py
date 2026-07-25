"""Turn a SerpAPI transcript payload into one continuous document.

Auto-generated transcripts are cut on a fixed cadence (~8s), not on sentence
boundaries, so individual snippets routinely split a claim in half:

    "The Fold 8 comes in at a humble $1,899."
    "is bad, but not that bad for a foldable."

Checking snippets independently would therefore miss or mangle claims. We
stitch them into one document, extract claims from that, and map each claim
back to a timestamp by locating its quote in the stitched text.
"""

from dataclasses import dataclass

from rapidfuzz import fuzz

from .schemas import FactCheckRequest, TranscriptSegment

#: Similarity a quote must reach to be credited to a segment. Loose on purpose:
#: a wrong timestamp is a small cosmetic error, while no timestamp costs the
#: caller the ability to point at the moment in the video.
FUZZY_LOCATE_THRESHOLD = 75.0


@dataclass(frozen=True)
class Anchor:
    """Where one segment's text landed inside the stitched document."""

    start: int  # inclusive char offset
    end: int  # exclusive char offset
    start_ms: int | None
    start_time_text: str | None


@dataclass
class Transcript:
    text: str
    anchors: list[Anchor]
    video_url: str | None = None
    declared_language: str | None = None
    truncated: bool = False

    def locate(self, quote: str) -> Anchor | None:
        """Find the segment a quote came from.

        The model is asked for verbatim spans, but it may normalise whitespace,
        fix transcription artefacts, or merge across a segment boundary. Exact
        search first, then a fuzzy sweep so a lightly-reworded quote still gets
        a timestamp instead of silently losing it.
        """
        quote = (quote or "").strip()
        if not quote or not self.anchors:
            return None

        idx = self.text.find(quote)
        if idx == -1:
            idx = self.text.casefold().find(quote.casefold())
        if idx != -1:
            return self._anchor_at(idx)

        # Fuzzy fallback. Align the quote against the whole stitched document
        # and use where the match *starts*, rather than scoring each segment:
        # per-segment scoring cannot tell "the quote is here" from "the quote is
        # just after here", and a quote straddling a boundary scores well on
        # both segments it touches.
        alignment = fuzz.partial_ratio_alignment(quote.casefold(), self.text.casefold())
        if alignment is not None and alignment.score >= FUZZY_LOCATE_THRESHOLD:
            return self._anchor_at(alignment.dest_start)
        return None

    def _anchor_at(self, offset: int) -> Anchor | None:
        for anchor in self.anchors:
            if anchor.start <= offset < anchor.end:
                return anchor
        return self.anchors[-1] if self.anchors else None


def _segments_from_text(text: str) -> list[TranscriptSegment]:
    return [TranscriptSegment(snippet=text.strip())]


def build_transcript(request: FactCheckRequest, max_chars: int) -> Transcript:
    segments = request.transcript or _segments_from_text(request.text or "")

    parts: list[str] = []
    anchors: list[Anchor] = []
    cursor = 0
    truncated = False

    for segment in segments:
        snippet = (segment.snippet or "").strip()
        if not snippet:
            continue
        if cursor + len(snippet) > max_chars:
            truncated = True
            break
        parts.append(snippet)
        anchors.append(
            Anchor(
                start=cursor,
                end=cursor + len(snippet),
                start_ms=segment.start_ms,
                start_time_text=segment.start_time_text,
            )
        )
        cursor += len(snippet) + 1  # the joining space

    metadata = request.search_metadata or {}
    parameters = request.search_parameters or {}

    return Transcript(
        text=" ".join(parts),
        anchors=anchors,
        video_url=metadata.get("youtube_video_transcript_url"),
        declared_language=request.response_language
        or (parameters.get("language_code") or "").split("-")[0]
        or None,
        truncated=truncated,
    )
