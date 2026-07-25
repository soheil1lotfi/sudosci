"""Transport and authentication for the alien.club MCP server.

Two auth modes, in order of preference:

* **Static API key** (`MCP_API_KEY`) - an `oat_...` token issued by alien.club,
  sent as a bearer token. This is the simple path and needs no browser.
* **OAuth refresh token** (`MCP_CLIENT_ID` + `MCP_REFRESH_TOKEN`) - for when a
  long-lived key is not available. `scripts/mcp_login.py` mints these through a
  one-time browser consent; the service itself only ever refreshes.

The `?config=...` segment of the URL is not a credential - it selects which
toolset the server exposes for the account.
"""

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import Settings

logger = logging.getLogger(__name__)

TOKEN_ENDPOINT = "https://mcp.alien.club/token"


class ResearchUnavailable(RuntimeError):
    """The research MCP could not be reached, or is not configured."""


class _StaticTokenAuth(httpx.Auth):
    def __init__(self, token: str) -> None:
        self._token = token

    def auth_flow(self, request: httpx.Request) -> Any:
        request.headers["Authorization"] = f"Bearer {self._token}"
        yield request


class _RefreshTokenAuth(httpx.Auth):
    """Injects a bearer token, refreshing it when it expires or is rejected."""

    def __init__(self, client_id: str, client_secret: str, refresh_token: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        self._access_token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def _refresh(self) -> str:
        payload = {
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "client_id": self._client_id,
        }
        if self._client_secret:
            payload["client_secret"] = self._client_secret

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(TOKEN_ENDPOINT, data=payload)
        if response.status_code != 200:
            raise ResearchUnavailable(
                f"MCP token refresh failed ({response.status_code}): "
                f"{response.text[:200]}. Re-run `python scripts/mcp_login.py`."
            )

        body = response.json()
        self._access_token = body["access_token"]
        # Refresh a minute early so a long request cannot straddle expiry.
        self._expires_at = time.monotonic() + float(body.get("expires_in", 3600)) - 60
        if rotated := body.get("refresh_token"):
            self._refresh_token = rotated  # Authentik rotates these
        return self._access_token

    async def _token(self, *, force: bool = False) -> str:
        async with self._lock:
            if force or not self._access_token or time.monotonic() >= self._expires_at:
                return await self._refresh()
            return self._access_token

    async def async_auth_flow(self, request: httpx.Request) -> AsyncIterator[httpx.Request]:
        request.headers["Authorization"] = f"Bearer {await self._token()}"
        response = yield request
        if response.status_code == 401:
            # Rejected despite looking fresh - refresh once and retry.
            request.headers["Authorization"] = f"Bearer {await self._token(force=True)}"
            yield request


def build_auth(settings: Settings) -> httpx.Auth | None:
    if settings.mcp_api_key:
        return _StaticTokenAuth(settings.mcp_api_key)
    if settings.mcp_client_id and settings.mcp_refresh_token:
        return _RefreshTokenAuth(
            settings.mcp_client_id, settings.mcp_client_secret, settings.mcp_refresh_token
        )
    return None


class MCPTransport:
    """Calls tools on the MCP server.

    Each call opens its own short-lived session. One long-lived session would
    save a handshake per call, but it would serialise concurrent claim
    verification behind a single stream and would need stale-session recovery.
    The handshake is cheap next to the searches themselves, which are
    network-bound.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._auth = build_auth(settings)

    @property
    def configured(self) -> bool:
        return self._auth is not None

    def _connect(self) -> Any:
        if not self._auth:
            raise ResearchUnavailable(
                "research MCP is not configured: set MCP_API_KEY (or "
                "MCP_CLIENT_ID + MCP_REFRESH_TOKEN)"
            )
        return streamablehttp_client(
            url=self._settings.mcp_url,
            auth=self._auth,
            timeout=self._settings.mcp_timeout_s,
        )

    async def list_tools(self) -> list[Any]:
        try:
            async with (
                self._connect() as (read, write, _),
                ClientSession(read, write) as session,
            ):
                await session.initialize()
                return list((await session.list_tools()).tools)
        except ResearchUnavailable:
            raise
        except Exception as exc:
            raise ResearchUnavailable(
                f"could not list MCP tools: {type(exc).__name__}: {exc}"
            ) from exc

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        try:
            async with (
                self._connect() as (read, write, _),
                ClientSession(read, write) as session,
            ):
                await session.initialize()
                result = await session.call_tool(name, arguments)
        except ResearchUnavailable:
            raise
        except Exception as exc:
            raise ResearchUnavailable(
                f"MCP call to {name!r} failed: {type(exc).__name__}: {exc}"
            ) from exc

        if getattr(result, "isError", False):
            detail = first_text(result) or str(result)
            raise ResearchUnavailable(f"MCP tool {name!r} returned an error: {detail[:300]}")
        return result


def first_text(result: Any) -> str | None:
    """The first non-empty text block of a tool result."""
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            return text
    return None
