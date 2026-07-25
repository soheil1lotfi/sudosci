# Fact-check backend integration

The extension talks to one endpoint: `POST /v1/factcheck`. Everything else
(`/health`, `/ready`, `/v1/research/tools`) is used only for the popup's **Test**
button.

## No CORS middleware needed

The request is made from the **service worker**, not a content script. Extension
background fetches with matching `host_permissions` are exempt from CORS, so the
backend can stay as it is. A content script calling it directly *would* be
blocked — that is why [`factcheck.js`](../src/background/factcheck.js) lives in
the background and the content script asks for stored results instead.

`localhost` and `127.0.0.1` are in `host_permissions`. Any other host is an
*optional* permission, requested from the popup when you save the URL (the click
is the required user gesture).

## Configuration

Popup → Fact check:

| Field | Setting key | Default |
| --- | --- | --- |
| Backend URL | `factcheckUrl` | `http://localhost:8080` |
| Backend API key | `factcheckKey` | empty — no `Authorization` header is sent |
| Check automatically | `autoFactcheck` | **on** |
| Mark every claim | `showAllVerdicts` | **on** |

Opening a video fetches the transcript and then checks it, with no interaction.
A run is 30–120 s of model time and up to 24 searches, but it happens once per
video: the result is cached and only recomputed on an explicit **Re-check**.

Auto-checks are **queued, one at a time**. Browsing through several videos would
otherwise start a full run for each in parallel and multiply the search spend; a
queued video whose tab has moved on is dropped rather than checked. Manual
**Check claims** is never queued.

A run outlives the popup, so the service worker holds itself alive while a
request is in flight (MV3 evicts an idle worker after ~30 s and a pending fetch
does not reliably count as activity).

The key is only sent when non-empty, matching the server's gate being a no-op
when `API_KEY` is unset.

## Request

The stored transcript document is flattened into the `transcript` array:

```jsonc
{
  "transcript": [
    { "start_ms": 34920, "snippet": "…", "start_time_text": "0:34" }
  ],
  "search_metadata":   { "youtube_video_transcript_url": "https://www.youtube.com/watch?v=…" },
  "search_parameters": { "language_code": "en" },
  "offline": false
}
```

Cues are sorted by `start_ms` and empty snippets dropped. The passthrough fields
are populated because the backend mines them; they cost nothing if ignored. The
same shape is produced by the audio-capture path, so a video with no captions
works identically.

## Response handling

- **Nulls are absent, not null.** `start_ms`, `start_time_text`, `url` and
  `title` are tested with `Number.isFinite` / truthiness, never `=== null`.
- **Citation order is preserved.** The backend sorts strongest tier first, exact
  quotes before fuzzy; the panel renders in array order and never re-sorts.
- **`quote_exact: false`** renders a "fuzzy match" tag, so weaker evidence reads
  as weaker.
- **`adjustments`** go in a collapsed *Adjustments* expander — the "why is this
  weaker than it looks" channel.
- **`research_enabled: false`** shows an amber banner in the panel and a warning
  in the popup, so `unverifiable` is not misread as "we checked and found
  nothing".
- **Claims with no `start_ms`** cannot be placed on the timeline. They are kept
  and counted (`unplaced` in the content status, and in the popup line) rather
  than dropped.

### Verdict → marker

| Verdict | Colour | Emphasis |
| --- | --- | --- |
| `false` | red | full-height pin |
| `misleading` | amber | full-height pin |
| `needs_context` | blue | full-height pin |
| `supported` | green | short, dimmed |
| `unverifiable` | grey | short, dimmed |
| `opinion` | purple | short, dimmed |
| anything unrecognised | grey | full-height — an added verdict must not vanish |

Every located claim is marked by default. Showing only problems meant a checked
video with nothing wrong looked identical to one that was never checked, which
reads as the extension being broken — so the distinction is carried by pin
height and opacity instead of by presence. `showAllVerdicts: false` restores
problems-only.

Citation `source_tier` covers all nine values in `schemas.py`, including
`private_corpus` (the account's own uploads — reported, not ranked highly).
`venue`, `year`, `doi`, `citation_count` and `peer_reviewed` render as a
bibliographic line under the source title.

"Show supported & unverifiable" turns the rest on. The palette lives in
`VERDICTS` in [`util.js`](../src/content/util.js).

## Verified against the real backend

`backend/` was run locally (uvicorn on :8080, model endpoint stubbed, no MCP) and
driven end to end from the extension. Confirmed live:

- the request passes `FactCheckRequest`'s validator, including
  `search_metadata` / `search_parameters` / `offline` passthrough
- `/ready`'s real body (`model.ok`, `model.name`, `research.configured`) parses
- `start_ms` from `ingest.locate` places a marker; a claim whose quote was not
  found comes back with `start_ms` **absent** and is bucketed, not dropped
- real `adjustments` strings render (`"verdict 'supported' had no citation that
  survived validation; downgraded to 'unverifiable'"`)
- `research_enabled: false` raises the panel banner

### Two things the port and the docs disagreed on

1. **The API listens on 8080**, not 8000 (`Dockerfile` `EXPOSE 8080`,
   `docker-compose.yml` `8080:8080`). The default URL was corrected.
2. **An unreachable model server returns 500, not the documented 502.**
   `llm.py:151` re-raises transport errors as-is, so `openai.APIConnectionError`
   never becomes an `LLMError` and `main.py`'s `except LLMError` never fires.
   The client special-cases 500 with "often the model server is unreachable"
   until that is wrapped.

### Transcripts are truncated at 24,000 characters

`max_transcript_chars` (backend `config.py`) hard-stops ingestion mid-transcript,
so a 26-minute video is checked only as far as the cap and the rest is never
seen. The response says so in `warnings`, and the popup surfaces it. Raising
`MAX_TRANSCRIPT_CHARS` is the fix; `MAX_CLAIMS=12` still caps how many claims
come back.

### When the timeline is empty

The popup names the reason rather than leaving it ambiguous: no claim could be
located (none has `start_ms`), search was unavailable, or nothing was flagged.

## Errors

| Status | What the user sees |
| --- | --- |
| 401 | `Backend rejected the API key (401)` |
| 422 | `Backend rejected the request (422) — body.transcript: field required` (first 3 issues) |
| 502 | the `detail` string verbatim |
| 503 | `Backend not ready (503) — …` |
| network | `Cannot reach the backend at <url> — …` |
| timeout | `Backend did not answer within 240s` |

The client timeout is 240 s — above the backend's own 180 s LLM timeout, so the
server gets to answer with a real error before the client gives up.

## Progress

There is no streaming, so there is no honest progress bar. The popup shows an
indeterminate state with elapsed seconds and the expected range, and the
background pushes results to the page when done — markers appear without a
reload.

**If per-claim progressive rendering matters, that is the SSE change to make.**
The frontend hook already exists: the background pushes a `sudosci:claims`
message and the overlay re-reads storage, so a stream would only need to write
partial results as they arrive.

## Testing without the backend

[`tools/mock-backend.mjs`](../tools/mock-backend.mjs) implements the documented
contract — bearer auth, the FastAPI 422 shape, `exclude_none` behaviour,
pre-sorted citations, a claim with no `start_ms`, and an `offline` mode:

```bash
node tools/mock-backend.mjs                  # open, on :8000
MOCK_API_KEY=secret node tools/mock-backend.mjs
MOCK_MODE=offline node tools/mock-backend.mjs   # research_enabled: false
MOCK_MODE=502 node tools/mock-backend.mjs       # model server error
MOCK_DELAY_MS=45000 node tools/mock-backend.mjs # exercise the long-wait UI
```

The extension needs no changes to point at it — it is the default URL.
