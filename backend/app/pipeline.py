"""The fact-checking pipeline: decompose, verify per claim, aggregate.

Shape of a request:

    stitch transcript
        -> decompose into atomic claims (one model call)
        -> gate on check-worthiness (no search for opinions or tautologies)
        -> per claim, in parallel: search/answer loop against the research MCP
        -> validate every citation against the retrieval log
        -> aggregate

The per-claim loop follows FIRE (Findings-Informed REtrieval): each turn the
model either issues a search or commits to a verdict, rather than searching a
fixed number of times first. Published results put this at ~7.6x lower LLM cost
and ~16.5x lower search cost than search-everything baselines, because most
claims settle in one or two queries and some need none at all.
"""

import asyncio
import json
import logging
import time
from typing import Any

from .citations import finalise_verdict, validate_evidence
from .config import Settings
from .ingest import Transcript, build_transcript
from .llm import LLM, LLMError
from .mcp_client import ResearchUnavailable
from .prompts import (
    decompose_messages,
    evidence_message,
    force_verdict_message,
    language_name,
    verify_system_prompt,
    verify_task_message,
)
from .research import EvidenceStore, ResearchService
from .schemas import (
    ClaimResult,
    ClaimType,
    DecompositionResult,
    ExtractedClaim,
    FactCheckRequest,
    FactCheckResponse,
    ModelVerdict,
    Verdict,
)

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM = """\
You write a two-sentence summary of a completed fact-check for the viewer.

State what was checked and what was found, leading with the most serious \
problem. Name the specific issue rather than describing the process. If \
nothing was found to be wrong, say so plainly. If claims could not be \
verified, say that rather than implying they were confirmed.

Write in {language_name}. Two sentences, no preamble, no bullet points.\
"""


class _Budget:
    """Shared search allowance for one request."""

    def __init__(self, total: int) -> None:
        self._remaining = total
        self._used = 0
        self._lock = asyncio.Lock()

    @property
    def used(self) -> int:
        return self._used

    async def take(self) -> bool:
        async with self._lock:
            if self._remaining <= 0:
                return False
            self._remaining -= 1
            self._used += 1
            return True


class FactChecker:
    def __init__(self, settings: Settings, llm: LLM, research: ResearchService) -> None:
        self._settings = settings
        self._llm = llm
        self._research = research

    # ----------------------------------------------------------------- #
    # Entry point
    # ----------------------------------------------------------------- #

    async def check(self, request: FactCheckRequest) -> FactCheckResponse:
        started = time.perf_counter()
        settings = self._settings
        warnings: list[str] = []

        transcript = build_transcript(request, settings.max_transcript_chars)
        if transcript.truncated:
            warnings.append(
                "transcript was truncated; only the opening portion was checked"
            )

        decomposition = await self._decompose(transcript)
        language = request.response_language or decomposition.language or "en"

        research_enabled = not request.offline and self._research.configured
        if request.offline:
            warnings.append(
                "offline mode: no sources were retrieved, so no claim can be "
                "confirmed and all verdicts are unverifiable"
            )
        elif not self._research.configured:
            warnings.append(
                "research MCP is not configured (set MCP_API_KEY); ran without "
                "external sources"
            )

        research_tools: list[dict[str, Any]] = []
        if research_enabled:
            try:
                research_tools = await self._research.openai_tools()
            except ResearchUnavailable as exc:
                logger.warning("could not resolve research tools: %s", exc)
                warnings.append(f"research tools unavailable: {exc}")
                research_enabled = False

        checkable = [c for c in decomposition.claims if c.check_worthy]
        skipped = [
            {
                "quote": c.quote,
                "claim": c.claim_en,
                "type": str(c.claim_type),
                "reason": c.skip_reason or "not check-worthy",
            }
            for c in decomposition.claims
            if not c.check_worthy
        ]

        store = EvidenceStore()
        budget = _Budget(settings.max_searches_per_request if research_enabled else 0)
        semaphore = asyncio.Semaphore(settings.claim_concurrency)

        async def verify(claim: ExtractedClaim) -> ClaimResult:
            async with semaphore:
                return await self._verify_claim(
                    claim=claim,
                    transcript=transcript,
                    language=language,
                    store=store,
                    budget=budget,
                    research_tools=research_tools,
                )

        results = await asyncio.gather(
            *(verify(claim) for claim in checkable), return_exceptions=True
        )

        claims: list[ClaimResult] = []
        for claim, outcome in zip(checkable, results, strict=True):
            if isinstance(outcome, BaseException):
                logger.exception("claim verification failed", exc_info=outcome)
                warnings.append(f"a claim could not be checked: {outcome}")
                claims.append(self._failed_result(claim, transcript, outcome))
            else:
                claims.append(outcome)

        summary = await self._summarise(claims, skipped, language, research_enabled)

        return FactCheckResponse(
            language=language,
            summary=summary,
            claims=claims,
            skipped=skipped,
            searches_used=budget.used,
            duration_ms=int((time.perf_counter() - started) * 1000),
            model=self._llm.model,
            research_enabled=research_enabled,
            warnings=warnings,
        )

    # ----------------------------------------------------------------- #
    # Stage 1: decomposition
    # ----------------------------------------------------------------- #

    async def _decompose(self, transcript: Transcript) -> DecompositionResult:
        if not transcript.text.strip():
            return DecompositionResult(language="en", claims=[])

        result = await self._llm.structured(
            messages=decompose_messages(transcript, self._settings.max_claims),
            schema=DecompositionResult,
            temperature=0.0,
            max_tokens=3072,
        )
        result.claims = result.claims[: self._settings.max_claims]

        # Opinions and definitional statements are never check-worthy no matter
        # what the model set, so the gate does not depend on it getting both
        # fields consistent.
        for claim in result.claims:
            if claim.claim_type in (ClaimType.OPINION, ClaimType.DEFINITIONAL):
                claim.check_worthy = False
                claim.skip_reason = claim.skip_reason or f"{claim.claim_type} statement"

        logger.info(
            "decomposed into %d claims (%d check-worthy), language=%s",
            len(result.claims),
            sum(1 for c in result.claims if c.check_worthy),
            result.language,
        )
        return result

    # ----------------------------------------------------------------- #
    # Stage 2: per-claim verification
    # ----------------------------------------------------------------- #

    async def _verify_claim(
        self,
        *,
        claim: ExtractedClaim,
        transcript: Transcript,
        language: str,
        store: EvidenceStore,
        budget: _Budget,
        research_tools: list[dict[str, Any]],
    ) -> ClaimResult:
        max_searches = self._settings.max_searches_per_claim if research_tools else 0

        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": verify_system_prompt(
                    max_searches=max_searches,
                    language=language,
                    scientific=claim.scientific,
                ),
            },
            {
                "role": "user",
                "content": verify_task_message(
                    claim_en=claim.claim_en,
                    quote=claim.quote,
                    domain=claim.domain,
                    transcript_language=transcript.declared_language or language,
                ),
            },
        ]

        searches_used = 0
        search_errors: list[str] = []

        while searches_used < max_searches:
            completion = await self._llm.with_tools(
                messages=messages, tools=research_tools, max_tokens=768
            )
            message = completion.choices[0].message
            tool_calls = list(message.tool_calls or [])

            if not tool_calls:
                # FIRE's early exit: the model is satisfied, so stop paying for
                # searches it does not want.
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            },
                        }
                        for call in tool_calls
                    ],
                }
            )

            for call in tool_calls:
                arguments = _parse_arguments(call.function.arguments)
                arguments.setdefault("query", claim.claim_en)
                if searches_used >= max_searches or not await budget.take():
                    content = (
                        "Search budget exhausted for this request. Answer using "
                        "the documents you already have."
                    )
                else:
                    searches_used += 1
                    try:
                        documents = await self._research.run(
                            call.function.name, arguments, store
                        )
                        content = evidence_message(documents)
                    except ResearchUnavailable as exc:
                        logger.warning("research call failed: %s", exc)
                        search_errors.append(str(exc))
                        content = (
                            "The research tool is unavailable, so no evidence "
                            "could be retrieved. Answer `unverifiable`."
                        )
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": content}
                )

            if search_errors:
                break

        messages.append(
            {"role": "user", "content": force_verdict_message(searches_used=searches_used)}
        )

        try:
            model_verdict = await self._llm.structured(
                messages=messages, schema=ModelVerdict, temperature=0.0, max_tokens=1024
            )
        except LLMError as exc:
            logger.warning("verdict generation failed for %r: %s", claim.claim_en, exc)
            return self._failed_result(claim, transcript, exc, searches_used=searches_used)

        citations, rejections = validate_evidence(model_verdict.evidence, store)
        verdict, confidence, notes = finalise_verdict(
            verdict=model_verdict.verdict,
            confidence=model_verdict.confidence,
            citations=citations,
        )

        adjustments = rejections + notes
        if search_errors:
            adjustments.append(f"research tool error: {search_errors[0]}")
        if rejections:
            logger.info("rejected %d citation(s) for %r", len(rejections), claim.claim_en)

        anchor = transcript.locate(claim.quote)
        return ClaimResult(
            quote=claim.quote,
            claim=claim.claim_en,
            claim_type=claim.claim_type,
            verdict=verdict,
            confidence=confidence,
            explanation=model_verdict.explanation.strip(),
            citations=citations,
            start_ms=anchor.start_ms if anchor else None,
            start_time_text=anchor.start_time_text if anchor else None,
            searches_used=searches_used,
            adjustments=adjustments,
        )

    # ----------------------------------------------------------------- #
    # Stage 3: aggregation
    # ----------------------------------------------------------------- #

    async def _summarise(
        self,
        claims: list[ClaimResult],
        skipped: list[dict[str, str]],
        language: str,
        research_enabled: bool,
    ) -> str:
        if not claims:
            return _fallback_summary(claims, skipped)

        lines = [
            f"- [{c.verdict}, confidence {c.confidence}] {c.claim}\n  {c.explanation}"
            for c in claims
        ]
        if skipped:
            lines.append(f"({len(skipped)} statement(s) skipped as not checkable.)")
        if not research_enabled:
            lines.append("(No external sources were retrieved for this check.)")

        try:
            completion = await self._llm.with_tools(
                messages=[
                    {
                        "role": "system",
                        "content": SUMMARY_SYSTEM.format(
                            language_name=language_name(language)
                        ),
                    },
                    {"role": "user", "content": "FACT-CHECK RESULTS:\n" + "\n".join(lines)},
                ],
                tools=None,
                temperature=0.2,
                max_tokens=256,
            )
            if summary := (completion.choices[0].message.content or "").strip():
                return summary
        except Exception as exc:  # noqa: BLE001 - summary is cosmetic
            logger.warning("summary generation failed: %s", exc)
        return _fallback_summary(claims, skipped)

    # ----------------------------------------------------------------- #

    @staticmethod
    def _failed_result(
        claim: ExtractedClaim,
        transcript: Transcript,
        error: BaseException,
        searches_used: int = 0,
    ) -> ClaimResult:
        anchor = transcript.locate(claim.quote)
        return ClaimResult(
            quote=claim.quote,
            claim=claim.claim_en,
            claim_type=claim.claim_type,
            verdict=Verdict.UNVERIFIABLE,
            confidence=0.0,
            explanation="This claim could not be checked because of an internal error.",
            citations=[],
            start_ms=anchor.start_ms if anchor else None,
            start_time_text=anchor.start_time_text if anchor else None,
            searches_used=searches_used,
            adjustments=[f"{type(error).__name__}: {error}"],
        )


def _parse_arguments(arguments: str | None) -> dict[str, Any]:
    """Decode a tool call's arguments into a kwargs dict.

    Tolerant on purpose: the query may arrive under one of several key names, or
    as a bare string rather than an object. A dropped query costs a whole search
    from the budget, so normalise rather than reject.
    """
    if not arguments or not arguments.strip():
        return {}
    try:
        parsed = json.loads(arguments)
    except (json.JSONDecodeError, TypeError):
        return {"query": arguments.strip().strip('"')}

    if isinstance(parsed, str):
        return {"query": parsed.strip()} if parsed.strip() else {}
    if not isinstance(parsed, dict):
        return {}

    result = dict(parsed)
    if not isinstance(result.get("query"), str) or not result["query"].strip():
        for alias in ("q", "search", "search_query", "text", "input", "keywords"):
            value = result.get(alias)
            if isinstance(value, str) and value.strip():
                result["query"] = value.strip()
                break
        else:
            result.pop("query", None)
    return result


def _fallback_summary(claims: list[ClaimResult], skipped: list[dict[str, str]]) -> str:
    """Deterministic summary, used when the model's summary call fails."""
    if not claims:
        if skipped:
            return (
                f"No checkable factual claims found; {len(skipped)} statement(s) "
                "were opinions or otherwise not verifiable."
            )
        return "No checkable factual claims were found in this transcript."

    counts: dict[Verdict, int] = {}
    for claim in claims:
        counts[claim.verdict] = counts.get(claim.verdict, 0) + 1
    breakdown = ", ".join(f"{count} {verdict}" for verdict, count in counts.items())

    disputed = counts.get(Verdict.FALSE, 0) + counts.get(Verdict.MISLEADING, 0)
    lead = (
        f"{disputed} of {len(claims)} checked claims are false or misleading."
        if disputed
        else f"No false or misleading claims found among {len(claims)} checked."
    )
    return f"{lead} Breakdown: {breakdown}."


def build_checker(settings: Settings) -> tuple[FactChecker, LLM, ResearchService]:
    llm = LLM(settings)
    research = ResearchService(settings)
    return FactChecker(settings, llm, research), llm, research
