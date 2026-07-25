"""Transcript stitching and claim-to-timestamp mapping."""

from app.ingest import build_transcript
from app.schemas import FactCheckRequest

# The example payload's last two segments split a sentence across a boundary,
# which is the case that makes per-snippet checking unworkable.
SERPAPI_PAYLOAD = {
    "search_metadata": {
        "id": "6a64bf66f680d1555289a93e",
        "status": "Success",
        "youtube_video_transcript_url": "https://www.youtube.com/watch?v=5jb1tQ10jGg",
    },
    "search_parameters": {
        "engine": "youtube_video_transcript",
        "v": "5jb1tQ10jGg",
        "language_code": "en",
    },
    "transcript": [
        {
            "start_ms": 0,
            "snippet": "Samsung just dropped a foldable with a brand new shape. "
            "This is the Galaxy ZFold 8.",
            "start_time_text": "0:00",
        },
        {
            "start_ms": 30000,
            "snippet": "The Fold 8 comes in at a humble $1,899.",
            "start_time_text": "0:30",
        },
        {
            "start_ms": 39000,
            "snippet": "is bad, but not that bad for a foldable.",
            "start_time_text": "0:39",
        },
    ],
}


def test_stitches_segments_into_one_document():
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    assert transcript.text.startswith("Samsung just dropped")
    # The split sentence is contiguous once stitched.
    assert "$1,899. is bad, but not that bad" in transcript.text
    assert len(transcript.anchors) == 3
    assert not transcript.truncated


def test_extracts_metadata_from_serpapi_envelope():
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    assert transcript.video_url == "https://www.youtube.com/watch?v=5jb1tQ10jGg"
    assert transcript.declared_language == "en"


def test_locates_exact_quote_timestamp():
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    anchor = transcript.locate("The Fold 8 comes in at a humble $1,899.")

    assert anchor is not None
    assert anchor.start_ms == 30000
    assert anchor.start_time_text == "0:30"


def test_locates_quote_spanning_a_segment_boundary():
    """A claim straddling two snippets anchors to where it starts."""
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    anchor = transcript.locate("comes in at a humble $1,899. is bad")

    assert anchor is not None
    assert anchor.start_ms == 30000


def test_locates_lightly_reworded_quote_via_fuzzy_match():
    """Models normalise whitespace and punctuation; a timestamp is still owed."""
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    anchor = transcript.locate("The Fold 8 comes in at a humble $1899")

    assert anchor is not None
    assert anchor.start_ms == 30000


def test_unrelated_quote_gets_no_timestamp():
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=10_000)

    assert transcript.locate("mitochondrial DNA replication in yeast") is None


def test_truncation_is_flagged_and_drops_whole_segments():
    transcript = build_transcript(FactCheckRequest(**SERPAPI_PAYLOAD), max_chars=90)

    assert transcript.truncated
    assert len(transcript.anchors) == 1
    # A partial segment is never emitted, so quotes stay locatable.
    assert transcript.text == SERPAPI_PAYLOAD["transcript"][0]["snippet"]


def test_accepts_plain_text_input():
    transcript = build_transcript(
        FactCheckRequest(text="  Vaccines cause autism.  "), max_chars=10_000
    )

    assert transcript.text == "Vaccines cause autism."
    assert transcript.locate("Vaccines cause autism.") is not None


def test_rejects_empty_request():
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        FactCheckRequest(text="   ")
