# Transcription pipeline

Produces one JSON document per media item, ready to hand to the claim-analysis
backend. Two sources feed the same document shape.

| | `serpapi-youtube` (default) | `tab-audio` (fallback) |
| --- | --- | --- |
| For | any video with a caption track | videos with no captions |
| Speed | whole video in ~2 s | realtime — 1 h of audio takes 1 h |
| Starts | automatically when a video opens | needs a popup click (Chrome requires a gesture for `tabCapture`) |
| Cost | one SerpApi search per video | free |
| Text from | YouTube's caption track, via SerpApi | the model you drop into `src/offscreen/transcriber.js` |

Both write the same chunks, so the backend cannot tell which produced a document
apart from `capture.source`.

## Document shape

```jsonc
{
  "schemaVersion": 1,
  "documentId": "youtube:aircAruvnKk",
  "media": {
    "platform": "youtube",
    "mediaId": "aircAruvnKk",
    "url": "https://www.youtube.com/watch?v=aircAruvnKk",
    "title": "But what is a neural network?",
    "author": "3Blue1Brown",
    "duration": 1119,
    "language": "en",
    "chapters": [{ "title": "Introduction example", "start": 0, "end": 67 }]
  },
  "capture": {
    "source": "serpapi-youtube",
    "model": "serpapi/youtube_video_transcript",
    "sampleRate": null,            // 16000 for tab-audio
    "chunkSeconds": 30,
    "overlapSeconds": 0,           // 2 for tab-audio
    "startedAt": "2026-07-25T13:54:33.357Z",
    "completedAt": "2026-07-25T13:54:35.061Z",
    "coverage": [[0, 1119]],       // media-time spans actually transcribed
    "requestedLanguage": "en",     // what was asked for…
    "transcriptType": null,        // 'asr' when the auto-generated track was used
    "searchId": "68852264fc8a…",   // traceable in the SerpApi dashboard
    "availableLanguages": ["ar", "de", "en", "..."],
    "availableTranscripts": [
      { "languageName": "English", "languageCode": "en", "type": "asr",
        "title": null, "selected": true }
    ]
  },
  "chunks": [
    {
      "index": 0,
      "start": 0,                  // media time, seconds
      "end": 31.199,
      "status": "done",            // pending | done | error | skipped
      "text": "[Music] This is a three. It's sloppily written and …",
      "segments": [
        { "start": 4.4, "end": 6.879, "text": "This is a three.", "confidence": null, "speaker": null }
      ],
      "metrics": null,             // { rms, speechRatio } on the audio path
      "model": "serpapi/youtube_video_transcript",
      "discontinuous": false,      // a seek happened inside this window
      "error": null
    }
  ]
}
```

Two fields matter more than they look:

- **`coverage`** — realtime capture only sees what the user played. Never assume
  a document covers the whole media; check the spans.
- **`discontinuous`** — the user seeked mid-window, so the audio in that chunk is
  not contiguous. Treat claims spanning it with suspicion.

## Where the pieces live

```
src/transcription/
  schema.js          document/chunk/segment factories, coverage merging, validation
  config.js          chunk length, overlap, target sample rate, tick rate
  chunk-segments.js  groups timestamped segments into windows (transcript-API path)

src/background/
  service-worker.js  orchestrator: sessions, message routing, export
  settings.js        API key + auto-fetch, in storage.local (not sync)
  clock.js           wall-clock -> media-time mapping
  store.js           documents in chrome.storage.local
  sources/serpapi-youtube.js   SerpApi transcript engine

src/offscreen/
  offscreen.js       tabCapture -> AudioContext -> windows -> transcriber
  chunker.js         pure sample-accurate windowing
  pcm-worklet.js     audio-thread PCM collector
  transcriber.js     ← THE MODEL SEAM

src/content/
  clock.js           announces new media; reports the playhead during capture
```

## The two hard parts

**Time alignment (audio path).** Captured audio is a stream of samples with no
idea where the playhead is. The content script reports `{mediaTime, paused,
rate}` twice a second; `background/clock.js` interpolates between those ticks to
turn a sample index into a timestamp. It handles pauses (media time freezes),
non-1× playback, and seeks — a jump larger than `seekToleranceSeconds` between
two ticks is a seek, and windows spanning one are flagged rather than smeared
across the jump.

**Windowing.** `Chunker` counts samples rather than wall-clock, so boundaries are
exact regardless of when messages arrive. Windows are 30 s with 2 s of overlap so
words are not cut in half; the backend de-duplicates the repeated span. On pause,
the buffer is discarded (`reset()`) but the absolute sample position is kept, so
nothing drifts.

## Swapping in the model

Replace the body of `transcribe()` in [`src/offscreen/transcriber.js`](../src/offscreen/transcriber.js).
It runs in the offscreen document, where the audio already is — a local model
(transformers.js, whisper wasm, WebGPU) loads there directly, and a hosted model
is a `fetch()` from there. Audio never crosses a message boundary; only text
comes back.

```js
export async function transcribe({ audio, sampleRate, chunkIndex, durationSeconds }) {
  // audio: Float32Array, mono, 16 kHz, values in [-1, 1]
  return {
    segments: [{ start, end, text, confidence, speaker }], // CHUNK-RELATIVE seconds
    text: null,
    language: null,
    model: 'whisper-small',
  };
}
```

Segment times are relative to the start of the chunk. The pipeline shifts them
onto the media timeline — do not do it in the model.

The current stub runs energy-based voice-activity detection and returns segments
with `text: null`. It exists to prove the audio path works end to end; delete the
VAD helpers along with it.

For a hosted API, add the host to `host_permissions` in the manifest. Requests
from the service worker and offscreen document are exempt from CORS; requests
from a content script are not.

## Wiring the transcript into the markers

Still open. [`src/content/claims.js`](../src/content/claims.js) returns mock
claims; the real path is: document → backend (claim detection + verification) →
flagged spans → `fetchClaims` returns them → markers land on the timeline. The
document is already keyed by `platform:mediaId`, the same key the content script
knows, so the lookup is direct.

## Costs and limits

- **Each SerpApi fetch is a paid search**, except that an identical query inside
  an hour is served from SerpApi's own cache for free. Documents are also cached
  locally by video id and never re-fetched (`force: true` overrides); auto-fetch
  can be turned off in the popup.
- The API key lives in `chrome.storage.local`, seeded once from a gitignored
  `secrets.local.json`. It is still readable by anyone who installs the
  extension — a key in a client is a public key. Move it behind the backend
  before this ships to anyone else.
- `language_code` defaults to `en`. If the video has no track in that language,
  the engine falls back to the first language it does have — so a non-English
  video still transcribes, and `media.language` records what came back rather
  than what was asked for (`capture.requestedLanguage` keeps the ask). A language
  code that is not supported at all is a hard error instead.
- `type` is left unset so the engine returns the track YouTube marks as selected
  — human captions when they exist, ASR otherwise. Setting `transcriptType: 'asr'`
  forces the auto-generated track, which is usually worse.
- A failed fetch can arrive as `search_metadata.status: "Success"` with an `error`
  field set and no transcript (confirmed live). Check `error`, not just `status`.
- **Not every caption track has `end_ms`** — some return `start_ms` only. A cue
  then runs until the next one starts, and the last is estimated from its word
  count; `capture.endsEstimated` records that this happened, so the backend can
  treat those spans as approximate. Segment *starts* are always exact.
- A fetch that normalises to zero cues throws rather than storing an empty
  document, which would otherwise cache as a completed transcript.
- Tab capture holds one tab at a time and stops when the tab navigates or closes.
