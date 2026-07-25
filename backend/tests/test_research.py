"""Research-tool plumbing: payload unwrapping, parsing and tool resolution.

The OpenAIRE fixture is a real response captured from the live MCP server, so
these tests pin the parser against the shape it actually has to handle rather
than one invented to match the code.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.config import Settings
from app.mcp_client import ResearchUnavailable
from app.research import (
    SEARCH_LITERATURE,
    SEARCH_PRIVATE_CORPUS,
    SEARCH_RESEARCH_DATA,
    EvidenceStore,
    ResearchService,
    parse_datacluster,
    parse_openaire,
    unwrap,
)
from app.schemas import SourceTier

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "openaire_search.json").read_text(encoding="utf-8")
)


def _result(payload: Any) -> Any:
    """Mimic an MCP CallToolResult carrying JSON in a text block."""
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=json.dumps(payload))],
        structuredContent=None,
        isError=False,
    )


# --------------------------------------------------------------------------- #
# unwrap
# --------------------------------------------------------------------------- #


def test_unwrap_peels_success_data_envelope():
    payload = unwrap(_result({"success": True, "data": {"results": [1, 2]}}))

    assert payload == {"results": [1, 2]}


def test_unwrap_peels_fastmcp_result_string_wrapper():
    inner = json.dumps({"success": True, "data": {"results": []}})
    payload = unwrap(_result({"result": inner}))

    assert payload == {"results": []}


def test_unwrap_returns_plain_text_when_not_json():
    result = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="not json")],
        structuredContent=None,
    )

    assert unwrap(result) == "not json"


def test_unwrap_handles_empty_result():
    assert unwrap(SimpleNamespace(content=[], structuredContent=None)) is None


# --------------------------------------------------------------------------- #
# OpenAIRE parsing, against a real captured response
# --------------------------------------------------------------------------- #


def test_parses_real_openaire_response():
    documents = parse_openaire(FIXTURE["data"])

    assert len(documents) == 2
    doc = documents[0]
    assert doc.title.startswith("Vaccines are not associated with autism")
    assert doc.doi == "10.1016/j.vaccine.2014.04.085"
    assert doc.url == "https://doi.org/10.1016/j.vaccine.2014.04.085"
    assert doc.venue == "Vaccine"
    assert doc.year == "2014"
    assert doc.peer_reviewed is True
    assert doc.citation_count == 428
    assert doc.origin == "openaire"


def test_meta_analysis_is_tiered_above_primary_research():
    documents = parse_openaire(FIXTURE["data"])

    assert documents[0].tier is SourceTier.SYSTEMATIC_REVIEW


def test_title_and_abstract_are_both_quotable():
    """A claim is often settled by the title; validation must accept quotes from
    either, so both live in the document's quotable text."""
    doc = parse_openaire(FIXTURE["data"])[0]

    assert "Vaccines are not associated with autism" in doc.text
    assert "meta-analysis" in doc.text.casefold()
    # The abstract, not just the title.
    assert len(doc.text) > len(doc.title) + 50


def test_prompt_rendering_exposes_metadata_and_citable_id():
    store = EvidenceStore()
    doc = store.add(parse_openaire(FIXTURE["data"])[0])

    rendered = doc.for_prompt()

    assert rendered.startswith("[S1]")
    assert "Vaccine" in rendered
    assert "peer-reviewed" in rendered
    assert "cited 428x" in rendered
    assert "doi:10.1016/j.vaccine.2014.04.085" in rendered


def test_parse_openaire_tolerates_missing_and_malformed_records():
    assert parse_openaire(None) == []
    assert parse_openaire({}) == []
    assert parse_openaire({"results": "nope"}) == []
    # A record with neither title nor abstract carries no evidence.
    assert parse_openaire({"results": [{}, "junk"]}) == []


def test_peer_review_flag_absent_falls_back_to_url_heuristics():
    payload = {
        "results": [
            {
                "mainTitle": "An observational study of something",
                "descriptions": ["We observed some things over five years."],
                "instances": [{"urls": ["https://arxiv.org/abs/2401.00001"]}],
                "publisher": "arXiv",
            }
        ]
    }

    doc = parse_openaire(payload)[0]

    assert doc.tier is SourceTier.PREPRINT
    assert doc.peer_reviewed is None


def test_parse_openaire_caps_result_count():
    payload = {
        "results": [
            {"mainTitle": f"Paper {i}", "descriptions": [f"Abstract {i}"]} for i in range(50)
        ]
    }

    assert len(parse_openaire(payload)) <= 6


# --------------------------------------------------------------------------- #
# Datacluster parsing
# --------------------------------------------------------------------------- #


def test_parse_datacluster_extracts_chunks():
    payload = {
        "results": [
            {
                "text": "The measured warming trend was 0.18 degrees per decade.",
                "metadata": {"title": "Internal report", "doi": "10.5/xyz", "year": "2023"},
                "url": "https://files.example/report.pdf",
            }
        ]
    }

    documents = parse_datacluster(payload)

    assert len(documents) == 1
    assert documents[0].tier is SourceTier.PRIVATE_CORPUS
    assert documents[0].title == "Internal report"
    assert documents[0].doi == "10.5/xyz"
    assert documents[0].origin == "datacluster"


def test_parse_datacluster_handles_nested_and_empty_shapes():
    assert parse_datacluster({"success": True, "data": {"results": {}}}) == []
    assert parse_datacluster({"hits": [{"snippet": "A relevant passage of text."}]})[0].text
    assert parse_datacluster(None) == []


# --------------------------------------------------------------------------- #
# Tool resolution
# --------------------------------------------------------------------------- #


class FakeTransport:
    def __init__(self, tool_names: list[str], clusters: bool = False) -> None:
        self._tool_names = tool_names
        self._clusters = clusters
        self.configured = True
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def list_tools(self) -> list[Any]:
        return [
            SimpleNamespace(name=n, description="", inputSchema={})
            for n in self._tool_names
        ]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        self.calls.append((name, arguments))
        if name == "datacluster_list_datasets":
            results = {"1:1": {}} if self._clusters else {}
            return _result({"success": True, "data": {"results": results}})
        return _result({"success": True, "data": FIXTURE["data"]})


def _service(transport: FakeTransport, **overrides: Any) -> ResearchService:
    return ResearchService(Settings(mcp_api_key="test-key", **overrides), transport)


async def test_resolves_literature_tools_from_server_catalogue():
    service = _service(
        FakeTransport([SEARCH_LITERATURE.mcp_tool, SEARCH_RESEARCH_DATA.mcp_tool])
    )

    tools = await service.tools()

    assert sorted(tools) == ["search_literature", "search_research_data"]


async def test_private_corpus_tool_is_hidden_when_no_clusters_exist():
    """Offering a search over an empty corpus just burns a turn of the budget."""
    transport = FakeTransport(
        [SEARCH_LITERATURE.mcp_tool, SEARCH_PRIVATE_CORPUS.mcp_tool], clusters=False
    )

    tools = await _service(transport).tools()

    assert "search_private_corpus" not in tools


async def test_private_corpus_tool_appears_when_clusters_exist():
    transport = FakeTransport(
        [SEARCH_LITERATURE.mcp_tool, SEARCH_PRIVATE_CORPUS.mcp_tool], clusters=True
    )

    tools = await _service(transport).tools()

    assert "search_private_corpus" in tools


async def test_archive_tool_is_opt_in():
    names = [SEARCH_LITERATURE.mcp_tool, "bnf-gallica-sru-search-api_search_gallica"]

    assert "search_archive" not in await _service(FakeTransport(names)).tools()
    assert "search_archive" in await _service(
        FakeTransport(names), mcp_enable_archive=True
    ).tools()


async def test_missing_expected_tools_raises_with_the_available_list():
    service = _service(FakeTransport(["health", "set_profile"]))

    with pytest.raises(ResearchUnavailable, match="health"):
        await service.tools()


async def test_run_maps_model_arguments_onto_the_underlying_call():
    transport = FakeTransport([SEARCH_LITERATURE.mcp_tool])
    store = EvidenceStore()

    documents = await _service(transport).run(
        "search_literature",
        {"query": "MMR vaccine autism", "peer_reviewed_only": True, "from_year": 2010},
        store,
    )

    name, arguments = transport.calls[-1]
    assert name == SEARCH_LITERATURE.mcp_tool
    assert arguments["search"] == "MMR vaccine autism"
    assert arguments["isPeerReviewed"] is True
    assert arguments["fromPublicationYear"] == 2010
    assert len(documents) == 2
    assert store.documents["S1"].doi == "10.1016/j.vaccine.2014.04.085"
    assert store.queries == ["search_literature: MMR vaccine autism"]


async def test_run_falls_back_when_the_model_names_an_unknown_tool():
    """A hallucinated tool name should not waste the search."""
    transport = FakeTransport([SEARCH_LITERATURE.mcp_tool])
    store = EvidenceStore()

    documents = await _service(transport).run("web_search", {"query": "anything"}, store)

    assert transport.calls[-1][0] == SEARCH_LITERATURE.mcp_tool
    assert documents


async def test_unconfigured_service_reports_itself_unconfigured():
    service = ResearchService(Settings(mcp_api_key="", mcp_client_id="", mcp_refresh_token=""))

    assert not service.configured
