"""Request/response models and the internal claim representation.

The verdict vocabulary is deliberately small. Fact-checking research finds that
inter-annotator *and* inter-model agreement collapses on fine-grained middle
categories (mid-labels reach unanimity ~5% of the time vs 43-47% for
true/false), so we keep few labels, demand justification for the middle ones,
and always allow abstention via `unverifiable`.
"""

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class Verdict(StrEnum):
    SUPPORTED = "supported"
    MISLEADING = "misleading"
    FALSE = "false"
    NEEDS_CONTEXT = "needs_context"
    UNVERIFIABLE = "unverifiable"
    OPINION = "opinion"


#: Verdicts that must be backed by at least one validated citation. A model
#: asserting any of these with no surviving evidence is downgraded to
#: `unverifiable` in `pipeline.finalise_claim`.
EVIDENCE_REQUIRED: frozenset[Verdict] = frozenset(
    {Verdict.SUPPORTED, Verdict.MISLEADING, Verdict.FALSE, Verdict.NEEDS_CONTEXT}
)


class ClaimType(StrEnum):
    FACTUAL = "factual"
    OPINION = "opinion"
    PREDICTION = "prediction"
    DEFINITIONAL = "definitional"


class SourceTier(StrEnum):
    """Evidence quality ranking, strongest first.

    Scientific fact-checking needs an explicit hierarchy rather than treating
    every URL as equal: a meta-analysis and a personal blog are not
    interchangeable support for the same claim.
    """

    SYSTEMATIC_REVIEW = "systematic_review"  # reviews, meta-analyses, guidelines
    PEER_REVIEWED = "peer_reviewed"  # primary literature with a DOI
    PREPRINT = "preprint"  # arXiv, bioRxiv, medRxiv, SSRN
    FACT_CHECK = "fact_check"  # PolitiFact, Snopes, ClaimReview feeds
    INSTITUTIONAL = "institutional"  # .gov, .edu, WHO, NASA, standards bodies
    #: This account's own uploaded documents. Provenance is known but quality is
    #: not assessable from here, so it is reported rather than ranked highly.
    PRIVATE_CORPUS = "private_corpus"
    REPUTABLE_PRESS = "reputable_press"
    SCIENCE_JOURNALISM = "science_journalism"
    OTHER = "other"


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #


class TranscriptSegment(BaseModel):
    """One entry of a SerpAPI `youtube_video_transcript` response."""

    start_ms: int | None = None
    snippet: str = ""
    start_time_text: str | None = None
    start_time_label: str | None = None


class FactCheckRequest(BaseModel):
    """Accepts a full SerpAPI transcript payload, a bare segment list, or text.

    Callers most often pass the SerpAPI response straight through, so
    `search_metadata` / `search_parameters` are tolerated and mined for context
    (video URL, declared language) rather than rejected.
    """

    transcript: list[TranscriptSegment] | None = None
    text: str | None = None
    search_metadata: dict[str, Any] | None = None
    search_parameters: dict[str, Any] | None = None

    #: Force output language (ISO 639-1). Default: match the transcript.
    response_language: str | None = None
    #: Skip the research MCP and rely on model knowledge only. Much faster,
    #: much weaker - every verdict comes back with low confidence.
    offline: bool = False

    @model_validator(mode="after")
    def _require_content(self) -> "FactCheckRequest":
        if not self.transcript and not (self.text or "").strip():
            raise ValueError("provide either `transcript` (segments) or `text`")
        return self


# --------------------------------------------------------------------------- #
# Model-facing schemas
#
# These are handed to vLLM as guided-decoding JSON schemas, so they double as
# the contract for what the model may emit. Keep them flat and small: Gemma 4
# does not receive JSON-Schema `description` fields, so any semantic guidance
# has to live in the system prompt instead.
# --------------------------------------------------------------------------- #


class ExtractedClaim(BaseModel):
    """A single atomic claim, as returned by the decomposition call."""

    quote: str = Field(description="Verbatim span from the transcript")
    claim_en: str = Field(description="Decontextualised English restatement")
    claim_type: ClaimType = ClaimType.FACTUAL
    check_worthy: bool = True
    #: Free-form topic label ("consumer electronics", "climate science"). Used
    #: to bias source-tier expectations, not for control flow.
    domain: str = "general"
    scientific: bool = False
    skip_reason: str | None = None


class DecompositionResult(BaseModel):
    language: str = Field(description="ISO 639-1 code of the transcript")
    claims: list[ExtractedClaim] = Field(default_factory=list)


class ModelEvidence(BaseModel):
    """A citation as claimed by the model, before validation.

    `source_id` must name a document the MCP actually returned, and
    `quoted_span` must appear verbatim in it. Both are checked in
    `citations.validate_evidence`; unresolvable citations are discarded rather
    than trusted, which is what stops plausible-looking fabricated references
    from reaching the response.
    """

    source_id: str
    quoted_span: str
    stance: Literal["supports", "refutes", "partial", "context"] = "context"


class ModelVerdict(BaseModel):
    verdict: Verdict
    confidence: float = Field(ge=0.0, le=1.0)
    explanation: str
    evidence: list[ModelEvidence] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


class Citation(BaseModel):
    source_id: str
    url: str | None = None
    title: str | None = None
    quoted_span: str
    stance: str
    source_tier: SourceTier
    #: Bibliographic detail, when the source is a scholarly record. Surfaced so
    #: a reader can judge the evidence without following the link.
    venue: str | None = None
    year: str | None = None
    doi: str | None = None
    citation_count: int | None = None
    peer_reviewed: bool | None = None
    #: False when the span was not found verbatim in the retrieved document but
    #: matched closely enough to keep. Surfaced so callers can discount it.
    quote_exact: bool = True


class ClaimResult(BaseModel):
    quote: str
    claim: str
    claim_type: ClaimType
    verdict: Verdict
    confidence: float
    explanation: str
    citations: list[Citation] = Field(default_factory=list)
    start_ms: int | None = None
    start_time_text: str | None = None
    searches_used: int = 0
    #: Populated when post-hoc validation overrode the model's verdict.
    adjustments: list[str] = Field(default_factory=list)


class FactCheckResponse(BaseModel):
    language: str
    summary: str
    claims: list[ClaimResult]
    #: Claims the model judged not worth checking (opinions, tautologies).
    skipped: list[dict[str, str]] = Field(default_factory=list)
    searches_used: int = 0
    duration_ms: int = 0
    model: str = ""
    research_enabled: bool = True
    warnings: list[str] = Field(default_factory=list)
