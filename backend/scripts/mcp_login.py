#!/usr/bin/env python3
"""One-time browser login to the alien.club research MCP.

FALLBACK ONLY. If you have an alien.club API key (`oat_...`), set MCP_API_KEY
instead and skip this entirely - it is simpler and needs no browser.

Use this when only OAuth is available. Run it on your own machine: it registers
an OAuth client, walks the authorisation-code + PKCE flow, and prints the three
values the backend needs. The deployed service then only ever performs the
non-interactive refresh_token grant, so it never needs a browser.

    python scripts/mcp_login.py

Paste the printed values into `backend/.env` locally, or into the Brev
Launchable's environment variables when deploying.

The `offline_access` scope is what makes the server issue a refresh token; drop
it and the credentials expire within the hour.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import secrets
import socket
import sys
import threading
import urllib.parse
import webbrowser
from typing import ClassVar

import httpx

DEFAULT_MCP_URL = "https://mcp.alien.club/mcp?config=cfg_UtzjgjDLGNrW"
SCOPES = "openid profile email offline_access"
CALLBACK_PATH = "/callback"


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Catches the single redirect back from the authorisation server."""

    result: ClassVar[dict[str, str]] = {}

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != CALLBACK_PATH:
            self.send_error(404)
            return

        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        _CallbackHandler.result = params

        ok = "code" in params
        message = (
            "Authorisation complete. You can close this tab and return to the terminal."
            if ok
            else "Authorisation failed: "
            + str(params.get("error_description") or params.get("error"))
        )
        body = (
            "<html><body style='font-family:system-ui;padding:3rem;max-width:40rem'>"
            f"<h2>{'Success' if ok else 'Failed'}</h2><p>{message}</p></body></html>"
        ).encode()

        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        """Silence the default request logging."""


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def discover(base: str) -> dict[str, str]:
    """Fetch the authorisation server's endpoints rather than hardcoding them."""
    url = f"{base.rstrip('/')}/.well-known/oauth-authorization-server"
    response = httpx.get(url, timeout=30.0, follow_redirects=True)
    response.raise_for_status()
    return response.json()


def register_client(registration_endpoint: str, redirect_uri: str) -> dict[str, str]:
    """RFC 7591 dynamic client registration."""
    payload = {
        "client_name": "sudosci transcript fact-checker",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "client_secret_post",
        "scope": SCOPES,
    }
    response = httpx.post(registration_endpoint, json=payload, timeout=30.0)
    if response.status_code not in (200, 201):
        sys.exit(
            f"Client registration failed ({response.status_code}): {response.text[:500]}"
        )
    return response.json()


def authorise(
    *, authorization_endpoint: str, client_id: str, redirect_uri: str, port: int, resource: str
) -> str:
    """Open the consent page and wait for the callback; return the auth code."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    state = secrets.token_urlsafe(24)

    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # RFC 8707: binds the token to this MCP server, which the MCP spec
        # requires and the server advertises via oauth-protected-resource.
        "resource": resource,
    }
    url = f"{authorization_endpoint}?{urllib.parse.urlencode(query)}"

    server = http.server.HTTPServer(("127.0.0.1", port), _CallbackHandler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()

    print(f"\nOpening your browser to authorise:\n  {url}\n")
    if not webbrowser.open(url):
        print("Could not open a browser automatically - paste the URL above.\n")
    print("Waiting for the redirect (5 minute timeout)...")

    thread.join(timeout=300)
    server.server_close()

    result = _CallbackHandler.result
    if not result:
        sys.exit("Timed out waiting for the authorisation redirect.")
    if "code" not in result:
        sys.exit(
            "Authorisation denied: "
            f"{result.get('error_description') or result.get('error', 'unknown error')}"
        )
    if result.get("state") != state:
        sys.exit("State mismatch on the callback - aborting rather than trusting it.")

    return f"{result['code']}|{verifier}"


def exchange(
    *,
    token_endpoint: str,
    code: str,
    verifier: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    resource: str,
) -> dict[str, str]:
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
        "resource": resource,
    }
    if client_secret:
        payload["client_secret"] = client_secret

    response = httpx.post(token_endpoint, data=payload, timeout=30.0)
    if response.status_code != 200:
        sys.exit(f"Token exchange failed ({response.status_code}): {response.text[:500]}")
    return response.json()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mcp-url",
        default=DEFAULT_MCP_URL,
        help="full MCP endpoint URL including the ?config=... segment",
    )
    parser.add_argument(
        "--save",
        metavar="PATH",
        help="also write the credentials to this file as JSON (gitignored)",
    )
    args = parser.parse_args()

    parts = urllib.parse.urlsplit(args.mcp_url)
    base = f"{parts.scheme}://{parts.netloc}"
    resource = base  # the audience the server advertises for its tokens

    print(f"Discovering OAuth endpoints at {base} ...")
    metadata = discover(base)

    port = _free_port()
    redirect_uri = f"http://localhost:{port}{CALLBACK_PATH}"

    print("Registering an OAuth client ...")
    client = register_client(
        metadata.get("registration_endpoint", f"{base}/register"), redirect_uri
    )
    client_id = client["client_id"]
    client_secret = client.get("client_secret", "")

    code_and_verifier = authorise(
        authorization_endpoint=metadata.get("authorization_endpoint", f"{base}/authorize"),
        client_id=client_id,
        redirect_uri=redirect_uri,
        port=port,
        resource=resource,
    )
    code, verifier = code_and_verifier.split("|", 1)

    print("Exchanging the authorisation code for tokens ...")
    tokens = exchange(
        token_endpoint=metadata.get("token_endpoint", f"{base}/token"),
        code=code,
        verifier=verifier,
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        resource=resource,
    )

    refresh_token = tokens.get("refresh_token", "")
    if not refresh_token:
        print(
            "\nWARNING: the server issued no refresh token, so these credentials "
            "will expire shortly. The `offline_access` scope may have been "
            "declined for this client.",
            file=sys.stderr,
        )

    print("\n" + "=" * 72)
    print("Add these to backend/.env, or to the Brev Launchable's env vars:")
    print("=" * 72)
    print(f"MCP_URL={args.mcp_url}")
    print(f"MCP_CLIENT_ID={client_id}")
    print(f"MCP_CLIENT_SECRET={client_secret}")
    print(f"MCP_REFRESH_TOKEN={refresh_token}")
    print("=" * 72)
    print("\nTreat these as secrets - the refresh token grants access on your behalf.")

    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "mcp_url": args.mcp_url,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token,
                },
                handle,
                indent=2,
            )
        print(f"Saved to {args.save}")


if __name__ == "__main__":
    main()
