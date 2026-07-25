"""The research tools the model may call, and how their results become evidence.

This server is not a web search engine. Its catalogue is scholarly and
archival - OpenAIRE's graph of publications, datasets and projects; the
Bibliothèque nationale de France's digitised holdings; and any private document
clusters on the account. That shapes what the service can and cannot do:

* Scientific, medical and technical claims verify well, against peer-reviewed
  literature with DOIs, journals and citation counts.
* Consumer pricing, product specifications, current events and celebrity claims
  have no corresponding source here and correctly come back `unverifiable`.

Rather than hand the model the server's raw tool names - which are generated
from OpenAPI specs and arrive as `openaire-graph-api-v3_search_5` with fifty
parameters - each entry below exposes a small, purposeful tool and maps it onto
the underlying call. Small tool surfaces with few arguments are chosen
deliberately: tool-choice accuracy falls off as both grow.
"""

import contextlib
import json
import logging
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from .config import Settings
from .mcp_client import MCPTransport, ResearchUnavailable, first_text
from .schemas import SourceTier
from .sources import classify_source

logger = logging.getLogger(__name__)

#: Wording that marks a publication as evidence synthesis rather than a single
#: primary study. Applied to scholarly records only, where the phrase is
#: reliable, not to arbitrary web text.
_REVIEW_TITLE = re.compile(
    r"\b(systematic review|meta-analys[ei]s|metaanalys[ei]s|umbrella review|"
    r"scoping review|cochrane|clinical practice guideline|consensus statement|"
    r"position statement|evidence synthesis|pooled analysis)\b",
    re.IGNORECASE,
)

_PREPRINT_VENUE = re.compile(
    r"\b(arxiv|biorxiv|medrxiv|chemrxiv|ssrn|preprint|research square)\b", re.IGNORECASE
)

MAX_RESULTS_PER_SEARCH = 6
MAX_ABSTRACT_CHARS = 1600


@dataclass
class Document:
    """One retrieved source, with the id the model must cite it by.

    `text` holds everything quotable - for a paper, its title plus abstract,
    since both are genuine content of the source and either may be the sentence
    that settles a claim. Bibliographic metadata is kept separate so it can be
    shown to the model without becoming quotable.
    """

    source_id: str
    text: str
    url: str | None = None
    title: str | None = None
    tier: SourceTier = SourceTier.OTHER
    venue: str | None = None
    year: str | None = None
    doi: str | None = None
    citation_count: int | None = None
    peer_reviewed: bool | None = None
    origin: str = ""

    def for_prompt(self, max_chars: int = MAX_ABSTRACT_CHARS) -> str:
        bits: list[str] = [f"[{self.source_id}]"]
        if self.title:
            bits.append(self.title)
        head = " ".join(bits)

        meta: list[str] = []
        if self.venue:
            meta.append(self.venue)
        if self.year:
            meta.append(self.year)
        if self.peer_reviewed is True:
            meta.append("peer-reviewed")
        elif self.tier is SourceTier.PREPRINT:
            meta.append("PREPRINT - not peer-reviewed")
        if self.citation_count is not None:
            meta.append(f"cited {self.citation_count}x")
        if self.doi:
            meta.append(f"doi:{self.doi}")
        elif self.url:
            meta.append(self.url)

        body = self.text if len(self.text) <= max_chars else self.text[:max_chars] + " ..."
        lines = [head]
        if meta:
            lines.append("  (" + " | ".join(meta) + ")")
        lines.append(body)
        return "\n".join(lines)


@dataclass
class EvidenceStore:
    """Retrieval log for one request.

    Every document shown to the model is registered here under a stable id.
    Citation validation joins against this store, so a `source_id` the model
    invented cannot survive into the response.
    """

    documents: dict[str, Document] = field(default_factory=dict)
    queries: list[str] = field(default_factory=list)
    _counter: int = 0

    def add(self, document: Document) -> Document:
        # The same paper found by two queries keeps its first id rather than
        # accumulating duplicate sources that would look like corroboration.
        key = document.doi or document.url
        if key:
            for existing in self.documents.values():
                if (existing.doi or existing.url) == key:
                    return existing
        self._counter += 1
        document.source_id = f"S{self._counter}"
        self.documents[document.source_id] = document
        return document

    def get(self, source_id: str) -> Document | None:
        return self.documents.get((source_id or "").strip())


# --------------------------------------------------------------------------- #
# Payload helpers
# --------------------------------------------------------------------------- #


def unwrap(result: Any) -> Any:
    """Get at the JSON payload inside an MCP tool result.

    FastMCP servers return JSON as a text block, and this one wraps responses in
    `{"success": true, "data": ...}`, sometimes with a further `{"result": "..."}`
    string layer from its output-schema wrapper. Peel all of that off.
    """
    payload: Any = getattr(result, "structuredContent", None)
    if not payload:
        text = first_text(result)
        if not text:
            return None
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return text

    for _ in range(3):
        if not isinstance(payload, dict):
            break
        if isinstance(payload.get("result"), str):
            try:
                payload = json.loads(payload["result"])
                continue
            except (json.JSONDecodeError, ValueError):
                return payload["result"]
        if "data" in payload and isinstance(payload["data"], (dict, list)):
            payload = payload["data"]
            continue
        break
    return payload


def _text_of(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return " ".join(_text_of(v) for v in value if v).strip()
    return ""


def _first(record: dict[str, Any], keys: Iterable[str]) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


# --------------------------------------------------------------------------- #
# Parsers
# --------------------------------------------------------------------------- #


def _openaire_identifiers(record: dict[str, Any]) -> tuple[str | None, str | None, bool]:
    """Extract (doi, url, peer_reviewed) from an OpenAIRE research product."""
    doi: str | None = None
    url: str | None = None
    peer_reviewed = False

    for instance in record.get("instances") or []:
        if not isinstance(instance, dict):
            continue
        if instance.get("refereed") == "peerReviewed":
            peer_reviewed = True
        for bucket in ("pids", "alternateIdentifiers"):
            for pid in instance.get(bucket) or []:
                if isinstance(pid, dict) and pid.get("scheme") == "doi" and not doi:
                    doi = str(pid.get("value") or "").strip() or None
        for candidate in instance.get("urls") or []:
            if isinstance(candidate, str) and candidate.startswith("http") and not url:
                url = candidate

    for pid in record.get("pids") or []:
        if isinstance(pid, dict) and pid.get("scheme") == "doi" and not doi:
            doi = str(pid.get("value") or "").strip() or None

    if doi and not url:
        url = f"https://doi.org/{doi}"
    return (doi, url, peer_reviewed)


def parse_openaire(payload: Any) -> list[Document]:
    """Turn an OpenAIRE search response into citable documents."""
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, list):
        return []

    documents: list[Document] = []
    for record in results[:MAX_RESULTS_PER_SEARCH]:
        if not isinstance(record, dict):
            continue

        title = _text_of(record.get("mainTitle")) or None
        abstract = _text_of(record.get("descriptions"))
        if not title and not abstract:
            continue

        doi, url, peer_reviewed = _openaire_identifiers(record)
        container = record.get("container") if isinstance(record.get("container"), dict) else {}
        venue = _text_of(container.get("name")) or _text_of(record.get("publisher")) or None
        year = (_text_of(record.get("publicationDate")) or "")[:4] or None

        citation_count: int | None = None
        indicators = record.get("indicators")
        if isinstance(indicators, dict):
            impact = indicators.get("citationImpact")
            if isinstance(impact, dict) and isinstance(impact.get("citationCount"), int):
                citation_count = impact["citationCount"]

        haystack = f"{title or ''} {abstract[:600]}"
        if _REVIEW_TITLE.search(haystack):
            tier = SourceTier.SYSTEMATIC_REVIEW
        elif _PREPRINT_VENUE.search(venue or ""):
            tier = SourceTier.PREPRINT
        elif peer_reviewed:
            tier = SourceTier.PEER_REVIEWED
        else:
            # Indexed in OpenAIRE but not flagged refereed: fall back to what
            # the host domain implies rather than assuming peer review.
            tier = classify_source(url, haystack)

        documents.append(
            Document(
                source_id="",  # assigned by EvidenceStore
                text=". ".join(part for part in (title, abstract) if part),
                url=url,
                title=title,
                tier=tier,
                venue=venue,
                year=year,
                doi=doi,
                citation_count=citation_count,
                peer_reviewed=peer_reviewed or None,
                origin="openaire",
            )
        )
    return documents


def parse_datacluster(payload: Any) -> list[Document]:
    """Turn a datacluster search response into citable documents.

    Shapes vary between keyword and vector search, and per dataset schema, so
    this walks for the recognisable fields instead of assuming one layout.
    """
    records: list[dict[str, Any]] = []

    def collect(node: Any, depth: int = 0) -> None:
        if depth > 5 or len(records) >= MAX_RESULTS_PER_SEARCH * 3:
            return
        if isinstance(node, list):
            for item in node:
                collect(item, depth + 1)
        elif isinstance(node, dict):
            for key in ("results", "hits", "chunks", "matches", "entries", "items"):
                if key in node:
                    collect(node[key], depth + 1)
                    return
            if any(k in node for k in ("text", "content", "snippet", "snippets", "chunk")):
                records.append(node)
            else:
                for value in node.values():
                    collect(value, depth + 1)

    collect(payload)

    documents: list[Document] = []
    for record in records[:MAX_RESULTS_PER_SEARCH]:
        metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
        text = (
            _first(record, ("text", "content", "chunk", "snippet"))
            or _text_of(record.get("snippets"))
            or ""
        )
        if not text:
            continue
        title = _first(record, ("title", "name", "filename")) or _first(
            metadata, ("title", "name")
        )
        doi = _first(metadata, ("doi",))
        documents.append(
            Document(
                source_id="",
                text=text,
                url=_first(record, ("url", "link")) or _first(metadata, ("url", "link")),
                title=title,
                tier=SourceTier.PRIVATE_CORPUS,
                venue=_first(metadata, ("journal", "publisher", "venue", "source")),
                year=(_first(metadata, ("published_date", "year", "date")) or "")[:4] or None,
                doi=doi,
                origin="datacluster",
            )
        )
    return documents


# --------------------------------------------------------------------------- #
# Tool registry
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ResearchTool:
    """A model-facing tool, mapped onto an underlying MCP call."""

    name: str
    description: str
    parameters: dict[str, Any]
    mcp_tool: str
    build_args: Callable[[dict[str, Any]], dict[str, Any]]
    parse: Callable[[Any], list[Document]]

    def as_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


def _literature_args(arguments: dict[str, Any]) -> dict[str, Any]:
    args: dict[str, Any] = {
        "search": str(arguments.get("query") or "").strip(),
        "pageSize": MAX_RESULTS_PER_SEARCH,
        # Most-cited first surfaces reviews and landmark studies ahead of
        # obscure single papers, which suits adjudicating a claim better than
        # raw keyword relevance does.
        "sortBy": "influence DESC",
    }
    if arguments.get("peer_reviewed_only"):
        args["isPeerReviewed"] = True
    if from_year := arguments.get("from_year"):
        # A year the model phrased oddly should not fail the whole search; drop
        # the filter and keep the query.
        with contextlib.suppress(TypeError, ValueError):
            args["fromPublicationYear"] = int(from_year)
    return args


SEARCH_LITERATURE = ResearchTool(
    name="search_literature",
    description=(
        "Search the scholarly literature (OpenAIRE: journals, conferences, "
        "repositories) for peer-reviewed publications bearing on a claim. "
        "Returns titles, abstracts, journals, DOIs and citation counts. Use "
        "short keyword queries naming the entities and the effect, not full "
        "sentences."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "peer_reviewed_only": {"type": "boolean"},
            "from_year": {"type": "integer"},
        },
        "required": ["query"],
    },
    mcp_tool="openaire-graph-api-v3_search_5",
    build_args=_literature_args,
    parse=parse_openaire,
)

SEARCH_RESEARCH_DATA = ResearchTool(
    name="search_research_data",
    description=(
        "Search published research datasets (OpenAIRE) for measured or recorded "
        "data bearing on a claim - statistics, survey results, measurement "
        "series. Use when a claim turns on a figure rather than on a finding."
    ),
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    },
    mcp_tool="openaire-graph-api-v3_search_6",
    build_args=lambda a: {
        "search": str(a.get("query") or "").strip(),
        "pageSize": MAX_RESULTS_PER_SEARCH,
    },
    parse=parse_openaire,
)

SEARCH_PRIVATE_CORPUS = ResearchTool(
    name="search_private_corpus",
    description=(
        "Semantic search over this account's own uploaded document collections. "
        "Use when a claim concerns material likely to be in these documents "
        "rather than in the public literature."
    ),
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    },
    mcp_tool="datacluster_vector_search_chunks",
    build_args=lambda a: {
        "query": str(a.get("query") or "").strip(),
        "limit": MAX_RESULTS_PER_SEARCH,
    },
    parse=parse_datacluster,
)

SEARCH_ARCHIVE = ResearchTool(
    name="search_archive",
    description=(
        "Search the Bibliothèque nationale de France's digitised holdings "
        "(Gallica): historical books, newspapers and periodicals. Use only for "
        "historical claims, or claims about what a period source said."
    ),
    parameters={
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"],
    },
    mcp_tool="bnf-gallica-sru-search-api_search_gallica",
    build_args=lambda a: {"query": str(a.get("query") or "").strip()},
    parse=parse_datacluster,  # generic walker; Gallica's shape is not fixed
)


class ResearchService:
    """Resolves which research tools are usable, and runs them.

    Availability is discovered from the server's `tools/list` at startup: the
    exposed toolset depends on the account's profile, so a tool defined here may
    simply not be present. The private-corpus tool is additionally gated on the
    account actually having document clusters, since offering an empty search
    just wastes a turn of the model's budget.
    """

    def __init__(self, settings: Settings, transport: MCPTransport | None = None) -> None:
        self._settings = settings
        self._transport = transport or MCPTransport(settings)
        self._tools: dict[str, ResearchTool] | None = None
        self._lock = None  # created lazily to avoid binding a loop at import

    @property
    def configured(self) -> bool:
        return self._transport.configured

    async def tools(self) -> dict[str, ResearchTool]:
        if self._tools is not None:
            return self._tools

        import asyncio

        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            if self._tools is not None:
                return self._tools

            available = {tool.name for tool in await self._transport.list_tools()}
            candidates = [SEARCH_LITERATURE, SEARCH_RESEARCH_DATA]
            if self._settings.mcp_enable_archive:
                candidates.append(SEARCH_ARCHIVE)
            if SEARCH_PRIVATE_CORPUS.mcp_tool in available and await self._has_clusters():
                candidates.append(SEARCH_PRIVATE_CORPUS)

            resolved = {t.name: t for t in candidates if t.mcp_tool in available}
            if not resolved:
                raise ResearchUnavailable(
                    "none of the expected research tools are exposed by the MCP "
                    f"server. Available tools: {sorted(available)}"
                )
            logger.info("research tools enabled: %s", sorted(resolved))
            self._tools = resolved
            return resolved

    async def _has_clusters(self) -> bool:
        try:
            payload = unwrap(
                await self._transport.call_tool("datacluster_list_datasets", {"limit": 1})
            )
        except ResearchUnavailable as exc:
            logger.info("skipping private-corpus search: %s", exc)
            return False
        results = payload.get("results") if isinstance(payload, dict) else None
        return bool(results)

    async def openai_tools(self) -> list[dict[str, Any]]:
        return [tool.as_openai_tool() for tool in (await self.tools()).values()]

    async def run(
        self, name: str, arguments: dict[str, Any], store: EvidenceStore
    ) -> list[Document]:
        """Execute one research call, registering its results in `store`."""
        tools = await self.tools()
        tool = tools.get(name)
        if tool is None:
            # The model named a tool that does not exist. Fall back to literature
            # search rather than burning the turn, since that is what it wanted
            # in almost every case.
            tool = tools.get(SEARCH_LITERATURE.name) or next(iter(tools.values()))
            logger.info("unknown tool %r requested; routing to %s", name, tool.name)

        query = str(arguments.get("query") or "").strip()
        store.queries.append(f"{tool.name}: {query}" if query else tool.name)

        payload = unwrap(
            await self._transport.call_tool(tool.mcp_tool, tool.build_args(arguments))
        )
        return [store.add(document) for document in tool.parse(payload)]
