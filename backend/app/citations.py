"""Mechanical validation of the model's citations.

Citation hallucination is the dominant failure mode for evidence-backed LLM
output, and it is not fixed by prompting alone - published rates run from 11%
to 57% even in current models. So we never take a citation on trust. Each one
must clear two checks:

1. **Resolvability** - the `source_id` must name a document the research tool
   actually returned during this request. Ids are minted by `EvidenceStore`, so
   an invented one cannot resolve.
2. **Verbatim quotation** - the `quoted_span` must appear in that document's
   text. Near-misses from whitespace or unicode normalisation are tolerated and
   flagged; anything further is discarded.

A claim whose citations all fail validation cannot keep an evidence-backed
verdict, so `finalise_verdict` downgrades it to `unverifiable`. That downgrade
is what makes the guarantee real rather than advisory.
"""

import re
import unicodedata

from rapidfuzz import fuzz

from .research import EvidenceStore
from .schemas import EVIDENCE_REQUIRED, Citation, ModelEvidence, Verdict
from .sources import TIER_RANK

#: Below-exact similarity that still counts as a quote, as a percentage. Set
#: high: the point is to absorb whitespace and punctuation drift, not to accept
#: paraphrase, which would defeat the check.
FUZZY_QUOTE_THRESHOLD = 92.0

#: Spans shorter than this carry no evidential weight - a three-word fragment
#: appears verbatim in almost any document by chance.
MIN_QUOTE_CHARS = 12

_WHITESPACE = re.compile(r"\s+")
_QUOTE_CHARS = str.maketrans(
    {
        "‘": "'", "’": "'", "‚": "'", "‛": "'",
        "“": '"', "”": '"', "„": '"', "′": "'",
        "″": '"', "–": "-", "—": "-", "−": "-",
        " ": " ", "…": "...",
    }
)


def normalise(text: str) -> str:
    """Fold away the differences a faithful quote may still contain.

    Models reliably reproduce wording but not typography: smart quotes become
    straight ones, em-dashes become hyphens, line wrapping collapses. NFKC plus
    punctuation folding plus whitespace collapse removes exactly those, while
    leaving actual wording changes visible to the comparison.
    """
    folded = unicodedata.normalize("NFKC", text or "").translate(_QUOTE_CHARS)
    return _WHITESPACE.sub(" ", folded).strip().casefold()


def _quote_matches(span: str, document_text: str) -> tuple[bool, bool]:
    """Return (matched, exact) for a quoted span against a document."""
    needle, haystack = normalise(span), normalise(document_text)
    if not needle or not haystack:
        return (False, False)
    if needle in haystack:
        return (True, True)
    score = fuzz.partial_ratio(needle, haystack)
    return (score >= FUZZY_QUOTE_THRESHOLD, False)


def validate_evidence(
    evidence: list[ModelEvidence], store: EvidenceStore
) -> tuple[list[Citation], list[str]]:
    """Keep the citations that resolve and quote faithfully; report the rest."""
    citations: list[Citation] = []
    rejections: list[str] = []
    seen: set[tuple[str, str]] = set()

    for item in evidence:
        source_id = (item.source_id or "").strip()
        document = store.get(source_id)
        if document is None:
            rejections.append(
                f"dropped citation to unknown source {source_id or '(blank)'!r} "
                "- not returned by the research tool"
            )
            continue

        span = (item.quoted_span or "").strip()
        if len(normalise(span)) < MIN_QUOTE_CHARS:
            rejections.append(f"dropped citation to {source_id}: quoted span too short")
            continue

        matched, exact = _quote_matches(span, document.text)
        if not matched:
            rejections.append(
                f"dropped citation to {source_id}: quoted span does not appear "
                "in the retrieved document"
            )
            continue

        key = (source_id, normalise(span))
        if key in seen:
            continue
        seen.add(key)

        citations.append(
            Citation(
                source_id=source_id,
                url=document.url,
                title=document.title,
                quoted_span=span,
                stance=item.stance,
                # The tier comes from whoever parsed the record: for a scholarly
                # result that means real metadata (refereed status, journal),
                # which beats guessing from the URL.
                source_tier=document.tier,
                venue=document.venue,
                year=document.year,
                doi=document.doi,
                citation_count=document.citation_count,
                peer_reviewed=document.peer_reviewed,
                quote_exact=exact,
            )
        )

    citations.sort(key=lambda c: (TIER_RANK[c.source_tier], not c.quote_exact))
    return citations, rejections


def finalise_verdict(
    *, verdict: Verdict, confidence: float, citations: list[Citation]
) -> tuple[Verdict, float, list[str]]:
    """Reconcile the model's verdict with the evidence that actually survived.

    Returns the adjusted verdict, an adjusted confidence, and human-readable
    notes describing any override, which the response surfaces so callers can
    see when the model was reined in.
    """
    notes: list[str] = []
    confidence = min(max(confidence, 0.0), 1.0)

    if verdict in EVIDENCE_REQUIRED and not citations:
        notes.append(
            f"verdict '{verdict}' had no citation that survived validation; "
            "downgraded to 'unverifiable'"
        )
        return (Verdict.UNVERIFIABLE, min(confidence, 0.2), notes)

    if verdict is Verdict.UNVERIFIABLE:
        # No evidence settled the claim, so high confidence is incoherent.
        confidence = min(confidence, 0.4)

    # One source cannot establish the certainty a >0.8 score claims. Corroborate
    # or come down. (Independent agreement is the signal; count of citations is
    # only a proxy for it, but a cheap and monotone one.)
    if confidence > 0.8 and len(citations) < 2:
        notes.append("confidence capped at 0.8: only one corroborating source")
        confidence = 0.8

    if citations and all(not c.quote_exact for c in citations):
        notes.append("all quoted spans matched approximately rather than verbatim")
        confidence = min(confidence, 0.6)

    return (verdict, round(confidence, 2), notes)
