#!/usr/bin/env python3
"""Verify the research MCP end to end, without needing a GPU or a model.

Confirms that credentials work, that the expected tools are exposed, and that a
real search returns documents the citation validator will accept. Run this
before deploying, and whenever a verdict comes back unexpectedly unverifiable.

    MCP_API_KEY=oat_... python scripts/check_mcp.py "vaccines autism meta-analysis"
"""

import asyncio
import sys

from app.citations import validate_evidence
from app.config import get_settings
from app.mcp_client import ResearchUnavailable
from app.research import EvidenceStore, ResearchService
from app.schemas import ModelEvidence


async def main() -> int:
    query = " ".join(sys.argv[1:]) or "MMR vaccine autism meta-analysis"
    settings = get_settings()

    if not settings.mcp_configured:
        print("MCP is not configured. Set MCP_API_KEY (or MCP_CLIENT_ID + "
              "MCP_REFRESH_TOKEN) in the environment or in backend/.env.")
        return 2

    service = ResearchService(settings)
    print(f"endpoint: {settings.mcp_url}")

    try:
        tools = await service.tools()
    except ResearchUnavailable as exc:
        print(f"FAILED to resolve tools: {exc}")
        return 1

    print("\ntools exposed to the model:")
    for tool in tools.values():
        print(f"  {tool.name:24s} -> {tool.mcp_tool}")

    store = EvidenceStore()
    print(f"\nsearching: {query!r}")
    try:
        documents = await service.run("search_literature", {"query": query}, store)
    except ResearchUnavailable as exc:
        print(f"FAILED search: {exc}")
        return 1

    if not documents:
        print("no documents returned - the query found nothing in the literature.")
        return 1

    print(f"\n{len(documents)} document(s):")
    for doc in documents:
        print(f"\n[{doc.source_id}] {doc.title}")
        print(f"     tier={doc.tier} venue={doc.venue} year={doc.year} "
              f"cited={doc.citation_count} doi={doc.doi}")
        print(f"     {doc.text[:180]}...")

    # Prove the citation path accepts a real quote and rejects a fabricated one,
    # which is the guarantee the whole response format rests on.
    first = documents[0]
    genuine = first.text[:120]
    citations, rejections = validate_evidence(
        [
            ModelEvidence(source_id=first.source_id, quoted_span=genuine, stance="supports"),
            ModelEvidence(source_id="S999", quoted_span=genuine, stance="supports"),
            ModelEvidence(
                source_id=first.source_id,
                quoted_span="This sentence was never in any retrieved document.",
                stance="supports",
            ),
        ],
        store,
    )

    print(f"\ncitation validation: kept {len(citations)}, rejected {len(rejections)}")
    for note in rejections:
        print(f"  rejected: {note}")

    ok = len(citations) == 1 and len(rejections) == 2
    print("\nOK" if ok else "\nUNEXPECTED validation result")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
