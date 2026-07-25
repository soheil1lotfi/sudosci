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
| Backend URL | `factcheckUrl` | `http://localhost:8000` |
| Backend API key | `factcheckKey` | empty — no `Authorization` header is sent |
| Check automatically | `autoFactcheck` | **off** |
| Show supported & unverifiable | `showAllVerdicts` | off |

Auto-check is off by default deliberately: a run is 30–120 s of model time and up
to 24 searches, so it is the user's call rather than something every video open
triggers. Turn it on and a transcript fetch chains straight into a check.

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

| Verdict | Colour | Marker by default |
| --- | --- | --- |
| `false` | red | yes |
| `misleading` | amber | yes |
| `needs_context` | blue | yes |
| `supported` | green | no |
| `unverifiable` | grey | no |
| `opinion` | purple | no |

"Show supported & unverifiable" turns the rest on. The palette lives in
`VERDICTS` in [`util.js`](../src/content/util.js).

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
