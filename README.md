# SudoSci — Claim Markers

Chrome extension (MV3) for YouTube. It injects clickable keypoint markers onto the
player's timeline; clicking one pauses playback, jumps to the claim, and opens a
panel.

It also collects the transcript. Opening a video fetches its captions (SerpApi) and
stores them as chunked JSON for the backend. Videos without captions can be
transcribed from tab audio instead. See [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).

Markers come from the fact-check backend: transcript → claim detection →
verification against literature → timestamped verdicts on the scrub bar. Wiring
and error handling are in [docs/BACKEND.md](docs/BACKEND.md); a mock server that
implements the contract ships in [tools/](tools/) so the frontend runs without it.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Open a YouTube video and press play

Opening a video fetches its transcript automatically. Then either point the popup
at your backend and hit **Check claims**, or run the mock:

```bash
node tools/mock-backend.mjs   # serves the documented contract on :8000
```

Markers appear as coloured pins on the scrub bar — red = false, amber =
misleading, blue = needs context. Clicking one pauses the video, jumps to the
claim, and opens the verdict with its sources.

## API key

Transcript fetching needs a SerpApi key. It is read from `secrets.local.json`
(gitignored) on first run and copied into `chrome.storage.local`, or you can paste
one into the popup:

```json
{ "serpApiKey": "..." }
```

A key shipped inside an extension is readable by anyone who installs it. Fine for
development; move it behind your backend before distributing.

## Layout

```
manifest.json
src/content/
  util.js               shared helpers, verdict palette, settings
  claims.js             reads stored analyses, filters by verdict
  adapters/youtube.js   YouTube + Shorts
  timeline.js           renders the marker overlay + tooltips
  panel.js              the claim panel — verdict, quote, sources
  index.js              controller: picks adapter, mounts, re-syncs
  clock.js              announces media, reports the playhead during capture
  styles.css
src/background/         orchestrator, settings, media clock, stores
  factcheck.js          POST /v1/factcheck client
  sources/serpapi-youtube.js
src/offscreen/          tab-audio capture + the transcription model seam
src/transcription/      document schema, chunking, config
src/popup/              toolbar popup (markers, transcript, fact check, keys)
tools/mock-backend.mjs  stand-in for the backend, implements the contract
docs/TRANSCRIPTION.md   how the transcript pipeline fits together
docs/BACKEND.md         how the fact-check integration fits together
```

## Wiring in the real backend

Point the popup at your `POST /v1/factcheck` server and it works — no code change.
The client is [src/background/factcheck.js](src/background/factcheck.js); request
shaping, error mapping, verdict colours and the long-request UI are described in
[docs/BACKEND.md](docs/BACKEND.md).

It runs in the service worker, so **your backend needs no CORS middleware** —
extension background fetches with `host_permissions` are exempt. Only
`localhost` is pre-granted; any other host is requested from the popup when you
save the URL.

## The claim panel

[src/content/panel.js](src/content/panel.js) renders one `ClaimResult`: verdict and
confidence, the decontextualised claim, the verbatim quote, the explanation, and
the citations in backend order (strongest tier first — never re-sorted), with
fuzzy matches tagged and `adjustments` in a collapsed expander.

## The player adapter

Everything player-specific is confined to
[src/content/adapters/youtube.js](src/content/adapters/youtube.js), which pushes
itself onto `window.__SUDOSCI.adapters`. The rest of the code only knows this
interface:

| method | purpose |
| --- | --- |
| `match()` | is this page mine? |
| `getTimeline()` | the progress-bar element to decorate |
| `getMedia()` | `{ platform, mediaId, duration, currentTime }` |
| `getMetadata()` | `{ title, author, url }` |
| `getPlaybackState()` | `{ mediaTime, paused, rate }` — used to align captured audio |
| `pause()` / `seek(seconds)` | transport control |
| `onMediaChange(cb)` | fire `cb` when the video changes |

Another platform would be a second file implementing the same methods, plus an
entry in `content_scripts` and `matches`. Nothing outside the adapter would change.

## Seeing the transcript

Open a video with DevTools on the page (F12 → Console). When the fetch lands you get:

```
[SudoSci] transcript fetched — 37 chunks, 500 segments
  ▸ document: {schemaVersion: 1, documentId: "youtube:aircAruvnKk", …}
  ▸ JSON: "{ …pretty-printed… }"
```

Expand `document` to browse it, or copy the `JSON` string. Failures print there too
(bad key, no captions in the requested language). The same lines appear in the
service worker console (`chrome://extensions` → SudoSci → *service worker*).

## Exporting a transcript

Popup → **Export JSON** writes `Downloads/sudosci/youtube_<id>.json`. That file is
what the backend consumes; its shape is documented in
[docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).

## Known limits

- The adapter reads YouTube's private DOM (`.ytp-*`). A markup change on their side
  breaks marker placement until the selectors are updated.
- Markers live inside the player chrome, so they hide when the controls auto-hide.
- Every transcript fetch is a paid SerpApi search. Results are cached per video id
  and never re-fetched; auto-fetch can be switched off in the popup.
- Tab audio capture cannot auto-start — Chrome requires a user gesture — and runs
  in realtime, so an hour of audio takes an hour.
- A fact check is one blocking request, plausibly 30–120 s, with no progress
  events. The popup shows elapsed time; per-claim streaming needs SSE on the
  backend.
- Claims whose quote could not be located come back without `start_ms` and cannot
  be placed on the timeline. They are counted in the popup rather than dropped.
