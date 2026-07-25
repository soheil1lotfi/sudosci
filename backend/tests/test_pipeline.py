"""End-to-end pipeline behaviour, with the model and research tool stubbed.

These run without a GPU or network. They cover the control flow that is easy to
get wrong and expensive to debug against a live model: the check-worthiness
gate, the search budget, early exit when the model wants no search, and the
downgrade path when the research tool is unavailable.
"""

from types import SimpleNamespace
from typing import Any

import pytest

from app.config import Settings
from app.mcp_client import ResearchUnavailable
from app.pipeline import FactChecker, _parse_arguments
from app.research import SEARCH_LITERATURE, Document, EvidenceStore
from app.schemas import (
    ClaimType,
    DecompositionResult,
    ExtractedClaim,
    FactCheckRequest,
    ModelVerdict,
    Verdict,
)

TRANSCRIPT = {
    "search_parameters": {"language_code": "en"},
    "transcript": [
        {
            "start_ms": 0,
            "snippet": "The Galaxy Z Fold 8 costs $1,899 and it is the lightest foldable.",
            "start_time_text": "0:00",
        },
        {
            "start_ms": 8000,
            "snippet": "Honestly I prefer the stubby one, it feels nice in the hand.",
            "start_time_text": "0:08",
        },
    ],
}

PRICE_CLAIM = ExtractedClaim(
    quote="The Galaxy Z Fold 8 costs $1,899",
    claim_en="The Samsung Galaxy Z Fold 8 has a launch price of $1,899.",
    claim_type=ClaimType.FACTUAL,
    check_worthy=True,
    domain="consumer electronics",
)
OPINION_CLAIM = ExtractedClaim(
    quote="I prefer the stubby one, it feels nice in the hand",
    claim_en="The speaker prefers the shorter foldable phone.",
    claim_type=ClaimType.OPINION,
    check_worthy=True,  # deliberately wrong; the gate must override it
    domain="consumer electronics",
)


def _tool_call(query: str, call_id: str = "call_1", name: str = "search_literature") -> Any:
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=f'{{"query": "{query}"}}'),
    )


def _completion(*, content: str = "", tool_calls: list[Any] | None = None) -> Any:
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content, tool_calls=tool_calls)
            )
        ]
    )


class FakeLLM:
    """Scripted stand-in for the vLLM client."""

    def __init__(
        self,
        *,
        decomposition: DecompositionResult,
        verdict: ModelVerdict,
        tool_call_turns: int = 1,
    ) -> None:
        self.model = "fake-gemma"
        self._decomposition = decomposition
        self._verdict = verdict
        self._tool_call_turns = tool_call_turns
        self.tool_turns_served = 0
        self.structured_calls: list[str] = []
        self.last_verify_messages: list[dict[str, Any]] = []

    async def structured(self, *, messages, schema, temperature=0.0, max_tokens=2048):
        self.structured_calls.append(schema.__name__)
        if schema is DecompositionResult:
            return self._decomposition.model_copy(deep=True)
        self.last_verify_messages = messages
        return self._verdict.model_copy(deep=True)

    async def with_tools(self, *, messages, tools, temperature=0.0, max_tokens=1024):
        if tools is None:  # the summary call
            return _completion(content="One claim checked; the price is wrong.")
        if self.tool_turns_served < self._tool_call_turns:
            self.tool_turns_served += 1
            return _completion(tool_calls=[_tool_call("galaxy z fold 8 price")])
        return _completion(content="I have enough evidence.")


class FakeResearch:
    def __init__(self, *, configured: bool = True, fail: bool = False) -> None:
        self.configured = configured
        self._fail = fail
        self.queries: list[str] = []

    async def tools(self) -> dict[str, Any]:
        return {SEARCH_LITERATURE.name: SEARCH_LITERATURE}

    async def openai_tools(self) -> list[dict[str, Any]]:
        return [SEARCH_LITERATURE.as_openai_tool()]

    async def run(self, name: str, arguments: dict[str, Any], store: EvidenceStore):
        self.queries.append(str(arguments.get("query") or ""))
        if self._fail:
            raise ResearchUnavailable("search backend is down")
        return [
            store.add(
                Document(
                    source_id="",
                    text="Samsung's Galaxy Z Fold 8 launched at $1,999 in the US market.",
                    url="https://www.theverge.com/fold8",
                    title="Galaxy Z Fold 8 pricing",
                )
            )
        ]


def _settings(**overrides: Any) -> Settings:
    base = {
        "max_searches_per_claim": 3,
        "max_searches_per_request": 24,
        "claim_concurrency": 4,
        "max_claims": 12,
        "mcp_api_key": "test-key",
    }
    return Settings(**{**base, **overrides})


def _verdict(**overrides: Any) -> ModelVerdict:
    base: dict[str, Any] = {
        "verdict": Verdict.FALSE,
        "confidence": 0.9,
        "explanation": "The launch price was $1,999, not $1,899.",
        "evidence": [
            {
                "source_id": "S1",
                "quoted_span": "launched at $1,999 in the US market",
                "stance": "refutes",
            }
        ],
    }
    return ModelVerdict(**{**base, **overrides})


async def test_happy_path_returns_validated_verdict_with_timestamp():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),
    )
    research = FakeResearch()
    checker = FactChecker(_settings(), llm, research)

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert response.language == "en"
    assert len(response.claims) == 1
    claim = response.claims[0]
    assert claim.verdict is Verdict.FALSE
    assert claim.start_ms == 0
    assert claim.start_time_text == "0:00"
    assert len(claim.citations) == 1
    assert claim.citations[0].url == "https://www.theverge.com/fold8"
    assert claim.searches_used == 1
    assert response.searches_used == 1
    # One source only, so confidence is capped rather than taken at 0.9.
    assert claim.confidence == 0.8


async def test_opinion_is_gated_out_before_any_search():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[OPINION_CLAIM]),
        verdict=_verdict(),
    )
    research = FakeResearch()
    checker = FactChecker(_settings(), llm, research)

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert response.claims == []
    assert len(response.skipped) == 1
    assert response.skipped[0]["type"] == ClaimType.OPINION
    assert research.queries == []
    assert response.searches_used == 0


async def test_model_declining_to_search_costs_no_searches():
    """FIRE's early exit: no tool call on the first turn means no retrieval."""
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(verdict=Verdict.UNVERIFIABLE, confidence=0.2, evidence=[]),
        tool_call_turns=0,
    )
    research = FakeResearch()
    checker = FactChecker(_settings(), llm, research)

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert research.queries == []
    assert response.claims[0].searches_used == 0
    assert response.claims[0].verdict is Verdict.UNVERIFIABLE


async def test_per_claim_search_budget_is_enforced():
    """A model that always wants another search is cut off at the budget."""
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),
        tool_call_turns=99,
    )
    research = FakeResearch()
    checker = FactChecker(_settings(max_searches_per_claim=2), llm, research)

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert len(research.queries) == 2
    assert response.claims[0].searches_used == 2


async def test_request_budget_caps_total_searches_across_claims():
    claims = [
        PRICE_CLAIM.model_copy(
            update={"quote": f"claim {i}", "claim_en": f"Claim {i} is true."}
        )
        for i in range(4)
    ]
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=claims),
        verdict=_verdict(),
        tool_call_turns=99,
    )
    research = FakeResearch()
    checker = FactChecker(
        _settings(max_searches_per_claim=3, max_searches_per_request=5), llm, research
    )

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert response.searches_used == 5
    assert len(research.queries) == 5


async def test_research_failure_yields_unverifiable_not_a_guess():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),  # model still asserts FALSE with a citation
        tool_call_turns=1,
    )
    checker = FactChecker(_settings(), llm, FakeResearch(fail=True))

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    claim = response.claims[0]
    # Nothing was retrieved, so the citation cannot resolve and the verdict
    # cannot stand.
    assert claim.verdict is Verdict.UNVERIFIABLE
    assert claim.citations == []
    assert any("unknown source" in note for note in claim.adjustments)


async def test_offline_mode_skips_research_and_warns():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),
    )
    research = FakeResearch()
    checker = FactChecker(_settings(), llm, research)

    response = await checker.check(FactCheckRequest(**TRANSCRIPT, offline=True))

    assert not response.research_enabled
    assert research.queries == []
    assert response.claims[0].verdict is Verdict.UNVERIFIABLE
    assert any("offline" in w for w in response.warnings)


async def test_unconfigured_research_warns_rather_than_failing():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),
    )
    checker = FactChecker(_settings(), llm, FakeResearch(configured=False))

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert not response.research_enabled
    assert any("not configured" in w for w in response.warnings)


async def test_response_language_override_is_honoured():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[PRICE_CLAIM]),
        verdict=_verdict(),
    )
    checker = FactChecker(_settings(), llm, FakeResearch())

    response = await checker.check(FactCheckRequest(**TRANSCRIPT, response_language="fr"))

    assert response.language == "fr"


async def test_max_claims_is_enforced():
    claims = [
        PRICE_CLAIM.model_copy(update={"claim_en": f"Claim {i}."}) for i in range(20)
    ]
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=claims),
        verdict=_verdict(verdict=Verdict.UNVERIFIABLE, confidence=0.1, evidence=[]),
        tool_call_turns=0,
    )
    checker = FactChecker(_settings(max_claims=5), llm, FakeResearch())

    response = await checker.check(FactCheckRequest(**TRANSCRIPT))

    assert len(response.claims) == 5


async def test_empty_transcript_short_circuits_the_model():
    llm = FakeLLM(
        decomposition=DecompositionResult(language="en", claims=[]), verdict=_verdict()
    )
    checker = FactChecker(_settings(), llm, FakeResearch())

    response = await checker.check(FactCheckRequest(text="."))

    assert response.claims == []
    assert "DecompositionResult" not in llm.structured_calls or response.claims == []


@pytest.mark.parametrize(
    ("arguments", "expected"),
    [
        ('{"query": "fold 8 price"}', "fold 8 price"),
        ('{"q": "fold 8 price"}', "fold 8 price"),
        ('{"search": "fold 8 price"}', "fold 8 price"),
        ('"fold 8 price"', "fold 8 price"),
        ("not json at all", "not json at all"),
        ('{"unrelated": 1}', None),
        ("", None),
        (None, None),
    ],
)
def test_parse_arguments_normalises_the_query_key(arguments, expected):
    assert _parse_arguments(arguments).get("query") == expected


def test_parse_arguments_preserves_other_tool_parameters():
    parsed = _parse_arguments('{"query": "warming trend", "from_year": 2015}')

    assert parsed == {"query": "warming trend", "from_year": 2015}
