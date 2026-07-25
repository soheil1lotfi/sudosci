"""FastAPI surface for the transcript fact-checking service."""

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse

from .config import Settings, get_settings
from .llm import LLM, LLMError
from .mcp_client import ResearchUnavailable
from .pipeline import FactChecker
from .research import ResearchService
from .schemas import FactCheckRequest, FactCheckResponse

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )

    llm = LLM(settings)
    research = ResearchService(settings)
    app.state.settings = settings
    app.state.llm = llm
    app.state.research = research
    app.state.checker = FactChecker(settings, llm, research)

    logger.info("serving model %s via %s", settings.llm_model, settings.llm_base_url)
    if not settings.mcp_configured:
        logger.warning(
            "research MCP not configured - requests will run without external "
            "sources and every verdict will be unverifiable. Set MCP_API_KEY."
        )
    else:
        # Resolve the toolset now so a misconfiguration shows up in the logs at
        # boot rather than on a caller's first request.
        try:
            logger.info("research tools: %s", sorted(await research.tools()))
        except ResearchUnavailable as exc:
            logger.warning("research MCP unreachable at startup: %s", exc)
    try:
        yield
    finally:
        await llm.aclose()


app = FastAPI(
    title="Transcript Fact-Check API",
    description=(
        "Extracts factual claims from a video transcript and checks each one "
        "against sources retrieved through a research MCP. Works on transcripts "
        "in any language."
    ),
    version="1.0.0",
    lifespan=lifespan,
)


async def require_api_key(
    authorization: Annotated[str | None, Header()] = None,
    settings: Annotated[Settings, Depends(get_settings)] = None,  # type: ignore[assignment]
) -> None:
    """Bearer-token gate. Disabled when API_KEY is unset (local dev)."""
    if not settings.api_key:
        return
    expected = f"Bearer {settings.api_key}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    """Liveness only - does not touch the model or the MCP."""
    return {"status": "ok"}


@app.get("/ready")
async def ready(request: Request) -> JSONResponse:
    """Readiness: is the model loaded, and is research reachable?

    Returns 503 until the model server answers, since the API is useless
    without it. A research MCP that is down is reported but not fatal - the
    service degrades to unverifiable verdicts rather than failing outright.
    """
    llm: LLM = request.app.state.llm
    research: ResearchService = request.app.state.research

    model_ok = await llm.health()
    body: dict[str, object] = {
        "model": {"ok": model_ok, "name": llm.model},
        "research": {"configured": research.configured},
    }

    if research.configured:
        try:
            body["research"] = {
                "configured": True,
                "ok": True,
                "tools": sorted(await research.tools()),
            }
        except ResearchUnavailable as exc:
            body["research"] = {"configured": True, "ok": False, "error": str(exc)}

    ready_now = model_ok
    body["status"] = "ready" if ready_now else "not_ready"
    return JSONResponse(
        body,
        status_code=status.HTTP_200_OK if ready_now else status.HTTP_503_SERVICE_UNAVAILABLE,
    )


@app.get("/v1/research/tools", dependencies=[Depends(require_api_key)])
async def research_tools(request: Request) -> dict[str, object]:
    """The research tools available to the model, and what they map onto.

    Which tools the MCP server exposes depends on the account's profile, so this
    reports what was actually resolved rather than what the code defines.
    """
    research: ResearchService = request.app.state.research
    try:
        tools = await research.tools()
    except ResearchUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    return {
        "tools": [
            {
                "name": tool.name,
                "mcp_tool": tool.mcp_tool,
                "description": tool.description,
            }
            for tool in tools.values()
        ]
    }


@app.post(
    "/v1/factcheck",
    response_model=FactCheckResponse,
    response_model_exclude_none=True,
    dependencies=[Depends(require_api_key)],
)
async def factcheck(payload: FactCheckRequest, request: Request) -> FactCheckResponse:
    """Fact-check a transcript.

    Accepts a SerpAPI `youtube_video_transcript` response verbatim, a bare list
    of transcript segments, or `{"text": "..."}`.
    """
    checker: FactChecker = request.app.state.checker
    try:
        return await checker.check(payload)
    except LLMError as exc:
        logger.exception("model call failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"model server error: {exc}",
        ) from exc
