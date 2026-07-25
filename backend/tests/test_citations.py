"""Citation validation - the guard against fabricated evidence.

These tests pin the behaviour the whole design rests on: a citation the model
invented must not reach the response, and a verdict that loses its evidence
must lose its confidence too.
"""

from app.citations import finalise_verdict, normalise, validate_evidence
from app.research import Document, EvidenceStore
from app.schemas import Citation, ModelEvidence, SourceTier, Verdict


def _doc(
    text: str,
    url: str | None = None,
    title: str | None = None,
    tier: SourceTier = SourceTier.OTHER,
    **extra: object,
) -> Document:
    return Document(source_id="", text=text, url=url, title=title, tier=tier, **extra)


def _store() -> EvidenceStore:
    store = EvidenceStore()
    store.add(
        _doc(
            "A 2024 systematic review and meta-analysis of 41 randomised trials found "
            "no association between the MMR vaccine and autism spectrum disorder.",
            url="https://pubmed.ncbi.nlm.nih.gov/12345678/",
            title="MMR vaccination and autism: a meta-analysis",
            tier=SourceTier.SYSTEMATIC_REVIEW,
            venue="Vaccine",
            year="2024",
            doi="10.1016/j.vaccine.2024.01.001",
            peer_reviewed=True,
        )
    )
    store.add(
        _doc(
            "The Galaxy Z Fold 8 launched at a price of $1,999 in the United States.",
            url="https://www.theverge.com/samsung-fold-8",
            title="Samsung announces the Galaxy Z Fold 8",
            tier=SourceTier.REPUTABLE_PRESS,
        )
    )
    return store


def test_valid_citation_carries_through_source_metadata():
    store = _store()
    evidence = [
        ModelEvidence(
            source_id="S1",
            quoted_span="no association between the MMR vaccine and autism spectrum disorder",
            stance="refutes",
        )
    ]

    citations, rejections = validate_evidence(evidence, store)

    assert not rejections
    assert len(citations) == 1
    citation = citations[0]
    assert citation.quote_exact
    assert citation.url == "https://pubmed.ncbi.nlm.nih.gov/12345678/"
    # Tier and bibliographic detail come from the parsed record, so a reader can
    # weigh the evidence without following the link.
    assert citation.source_tier is SourceTier.SYSTEMATIC_REVIEW
    assert citation.venue == "Vaccine"
    assert citation.year == "2024"
    assert citation.doi == "10.1016/j.vaccine.2024.01.001"
    assert citation.peer_reviewed is True


def test_invented_source_id_is_rejected():
    store = _store()
    evidence = [
        ModelEvidence(
            source_id="S99",
            quoted_span="Studies conclusively prove the vaccine is dangerous.",
            stance="supports",
        )
    ]

    citations, rejections = validate_evidence(evidence, store)

    assert citations == []
    assert len(rejections) == 1
    assert "unknown source" in rejections[0]


def test_fabricated_quote_against_a_real_source_is_rejected():
    """The harder failure: right document, invented sentence."""
    store = _store()
    evidence = [
        ModelEvidence(
            source_id="S1",
            quoted_span="The review found a clear causal link in children under five.",
            stance="supports",
        )
    ]

    citations, rejections = validate_evidence(evidence, store)

    assert citations == []
    assert "does not appear" in rejections[0]


def test_typographic_drift_is_tolerated():
    store = EvidenceStore()
    store.add(
        _doc(
            "Researchers said the effect was “modest” — around 3–5 percent.",
            url="https://example.org/study",
        )
    )
    # Straight quotes and a hyphen where the source had curly quotes and dashes.
    evidence = [
        ModelEvidence(
            source_id="S1",
            quoted_span='the effect was "modest" - around 3-5 percent',
            stance="partial",
        )
    ]

    citations, rejections = validate_evidence(evidence, store)

    assert not rejections
    assert len(citations) == 1
    assert citations[0].quote_exact


def test_too_short_span_is_rejected():
    store = _store()
    evidence = [ModelEvidence(source_id="S1", quoted_span="autism", stance="refutes")]

    citations, rejections = validate_evidence(evidence, store)

    assert citations == []
    assert "too short" in rejections[0]


def test_duplicate_citations_are_collapsed():
    store = _store()
    span = "no association between the MMR vaccine and autism spectrum disorder"
    evidence = [
        ModelEvidence(source_id="S1", quoted_span=span, stance="refutes"),
        ModelEvidence(source_id="S1", quoted_span=span.upper(), stance="refutes"),
    ]

    citations, _ = validate_evidence(evidence, store)

    assert len(citations) == 1


def test_citations_sort_strongest_tier_first():
    store = _store()
    evidence = [
        ModelEvidence(
            source_id="S2",
            quoted_span="launched at a price of $1,999 in the United States",
            stance="refutes",
        ),
        ModelEvidence(
            source_id="S1",
            quoted_span="no association between the MMR vaccine and autism spectrum disorder",
            stance="refutes",
        ),
    ]

    citations, _ = validate_evidence(evidence, store)

    assert [c.source_id for c in citations] == ["S1", "S2"]


def test_same_url_retrieved_twice_reuses_one_id():
    """Two queries finding one paper must not look like two agreeing sources."""
    store = EvidenceStore()
    first = store.add(_doc("Some text about the topic.", url="https://a.example"))
    second = store.add(_doc("Some text about the topic.", url="https://a.example"))

    assert first.source_id == second.source_id
    assert len(store.documents) == 1


def test_same_doi_from_different_urls_reuses_one_id():
    store = EvidenceStore()
    first = store.add(_doc("Abstract text.", url="https://doi.org/10.1/x", doi="10.1/x"))
    second = store.add(_doc("Abstract text.", url="https://repo.example/x", doi="10.1/x"))

    assert first.source_id == second.source_id
    assert len(store.documents) == 1


# --------------------------------------------------------------------------- #
# Verdict reconciliation
# --------------------------------------------------------------------------- #


def _citation(source_id: str = "S1", exact: bool = True) -> Citation:
    return Citation(
        source_id=source_id,
        url="https://pubmed.ncbi.nlm.nih.gov/12345678/",
        title=None,
        quoted_span="a quoted span of sufficient length",
        stance="supports",
        source_tier=SourceTier.PEER_REVIEWED,
        quote_exact=exact,
    )


def test_evidence_backed_verdict_without_citations_is_downgraded():
    verdict, confidence, notes = finalise_verdict(
        verdict=Verdict.FALSE, confidence=0.95, citations=[]
    )

    assert verdict is Verdict.UNVERIFIABLE
    assert confidence <= 0.2
    assert "downgraded" in notes[0]


def test_opinion_verdict_needs_no_citations():
    verdict, _, notes = finalise_verdict(
        verdict=Verdict.OPINION, confidence=0.7, citations=[]
    )

    assert verdict is Verdict.OPINION
    assert notes == []


def test_high_confidence_capped_on_a_single_source():
    _, confidence, notes = finalise_verdict(
        verdict=Verdict.SUPPORTED, confidence=0.99, citations=[_citation()]
    )

    assert confidence == 0.8
    assert "capped" in notes[0]


def test_two_sources_permit_high_confidence():
    _, confidence, notes = finalise_verdict(
        verdict=Verdict.SUPPORTED,
        confidence=0.95,
        citations=[_citation("S1"), _citation("S2")],
    )

    assert confidence == 0.95
    assert notes == []


def test_unverifiable_confidence_is_bounded():
    _, confidence, _ = finalise_verdict(
        verdict=Verdict.UNVERIFIABLE, confidence=0.9, citations=[]
    )

    assert confidence <= 0.4


def test_approximate_quotes_lower_confidence():
    _, confidence, notes = finalise_verdict(
        verdict=Verdict.SUPPORTED,
        confidence=0.9,
        citations=[_citation("S1", exact=False), _citation("S2", exact=False)],
    )

    assert confidence <= 0.6
    assert any("approximately" in note for note in notes)


def test_normalise_folds_typography_and_whitespace():
    assert normalise("  The  “effect”\nwas — modest ") == 'the "effect" was - modest'
