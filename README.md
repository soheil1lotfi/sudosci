# SudoSci — Claim Markers

Chrome extension (MV3) for YouTube. It injects clickable keypoint markers onto the
player's timeline; clicking one pauses playback, jumps to the claim, and opens a
panel.

It also collects the transcript. Opening a video fetches its captions (SerpApi) and
stores them as chunked JSON for the backend. Videos without captions can be
transcribed from tab audio instead. See [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md).

**Markers are still mock data.** The pipeline they represent: transcript → detect
scientific claims → verify against literature → return the false/misleading ones
as timestamped markers. The transcript half exists; the analysis half does not.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Open a YouTube video and press play

Markers appear as coloured pins on the scrub bar. Red = false, amber = misleading,
blue = unverified. The toolbar popup toggles markers, pause-on-click, and
jump-on-click, and shows how many markers are on the current media.

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
  util.js               shared helpers, severity palette, settings
  claims.js             claim source — THE BACKEND SEAM (see below)
  adapters/youtube.js   YouTube + Shorts
  timeline.js           renders the marker overlay + tooltips
  panel.js              the click-through panel (empty shell for now)
  index.js              controller: picks adapter, mounts, re-syncs
  clock.js              announces media, reports the playhead during capture
  styles.css
src/background/         orchestrator, settings, media clock, document store
src/offscreen/          tab-audio capture + the transcription model seam
src/transcription/      document schema, chunking, config
src/popup/              toolbar popup (markers, transcription, API key)
docs/TRANSCRIPTION.md   how the transcript pipeline fits together
```

## Wiring in the real backend

Replace the body of `fetchClaims` in [src/content/claims.js](src/content/claims.js).
It receives `{ platform, mediaId, duration }` and must resolve to an array of:

```js
{
  id: 'string',            // stable per claim
  time: 412.5,             // seconds into the media
  endTime: 424.5,          // optional
  severity: 'false' | 'misleading' | 'unverified',
  label: 'short tooltip text'
}
```

Nothing else needs to change — the overlay, tooltips, and panel all read that shape.
A cross-origin API call will also need the host added to `host_permissions` in the
manifest.

## Filling in the panel

[src/content/panel.js](src/content/panel.js) builds the shell and exposes
`open(claim)` / `close()`. The analysis view (transcript excerpt, verdict, sources)
goes inside `.sudosci-panel-body`, replacing the placeholder.

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
