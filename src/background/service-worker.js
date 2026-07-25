/* Orchestrator.
 *
 * Owns the capture session: starts tab capture, keeps the media clock, turns
 * transcriber output into stored chunks, and exports the document.
 *
 * Note on MV3 lifetimes: this worker can be evicted while the offscreen
 * document keeps running. Clock ticks arrive twice a second during capture,
 * which keeps it alive; session identity is also mirrored into
 * chrome.storage.session so a restart can recover rather than orphan a capture.
 */

import { CONFIG } from '../transcription/config.js';
import {
  CHUNK_STATUS,
  addCoverage,
  createChunk,
  createDocument,
  validateSegments,
} from '../transcription/schema.js';
import { chunkSegments } from '../transcription/chunk-segments.js';
import { MediaClock } from './clock.js';
import { checkReady, runFactCheck } from './factcheck.js';
import { getSettings, setSettings } from './settings.js';
import {
  MODEL_ID as SERPAPI_MODEL,
  SOURCE_ID as SERPAPI_SOURCE,
  fetchTranscript,
} from './sources/serpapi-youtube.js';
import {
  deleteDocument,
  getAnalysis,
  getDocument,
  listDocuments,
  putAnalysis,
  putDocument,
  summarize,
} from './store.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** @type {{tabId:number, documentId:string, clock:MediaClock, sampleRate:number|null, startedWall:number}|null} */
let session = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  const handler = HANDLERS[message.type];
  if (!handler) return false;

  Promise.resolve(handler(message, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true; // async response
});

const HANDLERS = {
  'factcheck:run': ({ tabId, force, offline }) => factcheckForTab(tabId, { force, offline }),
  'factcheck:status': ({ documentId }) => factcheckStatus(documentId),
  'factcheck:ping': async () => {
    const { factcheckUrl } = await getSettings();
    return { backend: await checkReady({ baseUrl: factcheckUrl }), url: factcheckUrl };
  },
  'claims:get': ({ platform, mediaId }) => claimsFor(`${platform}:${mediaId}`),
  'transcript:fetch': ({ tabId, force }) => fetchForTab(tabId, { force }),
  'media:detected': (message, sender) => onMediaDetected(message, sender),
  'settings:get': async () => ({ settings: redact(await getSettings()) }),
  'settings:set': async ({ patch }) => ({ settings: redact(await setSettings(patch)) }),
  'transcribe:start': ({ tabId }) => startCapture(tabId),
  'transcribe:stop': () => stopCapture(),
  'transcribe:status': ({ tabId }) => status(tabId),
  'transcribe:export': ({ documentId }) => exportDocument(documentId),
  'transcribe:list': async () => ({ documents: (await listDocuments()).map(summarize) }),
  'transcribe:delete': async ({ documentId }) => {
    await deleteDocument(documentId);
    return {};
  },
  'clock:tick': (message) => onClockTick(message),
  'capture:started': ({ sampleRate }) => {
    if (session) session.sampleRate = sampleRate;
    return {};
  },
  'capture:chunk': (message) => onChunk(message),
  'capture:ended': () => stopCapture(),
};

/* ---------- session lifecycle ---------- */

async function startCapture(tabId) {
  if (session) throw new Error('A capture is already running');
  if (!tabId) throw new Error('No tab to capture');

  const media = await askTab(tabId, { type: 'sudosci:media' });
  if (!media) throw new Error('No supported player found in this tab');

  // getMediaStreamId must be called while the extension has access to the tab
  // (the popup click grants it). This is why capture cannot auto-start.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const doc =
    (await getDocument(`${media.platform}:${media.mediaId}`)) ||
    createDocument({
      media,
      capture: {
        source: 'tab-audio',
        sampleRate: CONFIG.targetSampleRate,
        chunkSeconds: CONFIG.chunkSeconds,
        overlapSeconds: CONFIG.overlapSeconds,
        model: null, // stamped by the first chunk the transcriber returns
      },
    });
  doc.capture.completedAt = null;
  await putDocument(doc);

  session = {
    tabId,
    documentId: doc.documentId,
    clock: new MediaClock(),
    sampleRate: null,
    startedWall: Date.now(),
  };
  await chrome.storage.session.set({ activeSession: { tabId, documentId: doc.documentId } });

  await ensureOffscreen();
  const started = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'capture:start',
    streamId,
  });
  if (!started?.ok) {
    await teardown();
    throw new Error(started?.error || 'Could not start tab capture');
  }

  await askTab(tabId, { type: 'sudosci:clock:start', intervalMs: CONFIG.clockTickMs });
  return { documentId: doc.documentId };
}

async function stopCapture() {
  if (!session) return {};
  const { tabId, documentId } = session;

  // Ask the offscreen document to flush its tail before anything is torn down.
  await chrome.runtime
    .sendMessage({ target: 'offscreen', type: 'capture:stop' })
    .catch(() => {});
  await askTab(tabId, { type: 'sudosci:clock:stop' });

  const doc = await getDocument(documentId);
  if (doc) {
    doc.capture.completedAt = new Date().toISOString();
    await putDocument(doc);
  }

  await teardown();
  return { documentId };
}

async function teardown() {
  session = null;
  await chrome.storage.session.remove('activeSession');
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function status(tabId) {
  // With no live session, fall back to whatever was already transcribed for
  // the media in this tab, so a finished document stays exportable.
  let doc = null;
  if (session) {
    doc = await getDocument(session.documentId);
  } else if (tabId) {
    const media = await askTab(tabId, { type: 'sudosci:media' });
    if (media) doc = await getDocument(`${media.platform}:${media.mediaId}`);
  }

  return {
    capturing: !!session,
    tabId: session?.tabId ?? null,
    sampleRate: session?.sampleRate ?? null,
    document: summarize(doc),
  };
}

/* ---------- incoming data ---------- */

function onClockTick({ mediaTime, paused, rate }) {
  if (!session) return {};
  session.clock.addTick({ wall: Date.now(), mediaTime, paused: !!paused, rate: rate || 1 });

  // Stop accumulating audio while the media is paused; a paused tab is silence.
  if (session.lastPaused !== !!paused) {
    session.lastPaused = !!paused;
    chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'capture:setActive', active: !paused })
      .catch(() => {});
  }
  return {};
}

async function onChunk(message) {
  if (!session) return {};

  const { clock } = session;
  const doc = await getDocument(session.documentId);
  if (!doc) return {};

  // Wall-clock window -> media-time window.
  const start = clock.toMediaTime(message.startWall);
  const end = clock.toMediaTime(message.endWall);
  const known = Number.isFinite(start) && Number.isFinite(end) && end > start;

  const chunk = createChunk({
    index: message.index,
    start: known ? round(start) : null,
    end: known ? round(end) : null,
  });

  chunk.discontinuous = clock.hasDiscontinuity(message.startWall, message.endWall);
  chunk.model = message.model ?? null;
  chunk.metrics = message.metrics ?? null;

  if (message.error) {
    chunk.status = CHUNK_STATUS.ERROR;
    chunk.error = message.error;
  } else {
    const invalid = validateSegments(message.segments);
    if (invalid) {
      chunk.status = CHUNK_STATUS.ERROR;
      chunk.error = `malformed model output: ${invalid}`;
    } else if (clock.pausedRatio(message.startWall, message.endWall) > 0.9) {
      chunk.status = CHUNK_STATUS.SKIPPED;
    } else {
      chunk.status = CHUNK_STATUS.DONE;
      chunk.text = message.text ?? null;
      // Segments arrive chunk-relative; place them on the media timeline.
      const offset = known ? start : 0;
      chunk.segments = message.segments.map((s) => ({
        start: round(offset + s.start),
        end: round(offset + s.end),
        text: s.text ?? null,
        confidence: s.confidence ?? null,
        speaker: s.speaker ?? null,
      }));
    }
  }

  doc.chunks.push(chunk);
  doc.chunks.sort((a, b) => a.index - b.index);
  if (!doc.capture.model && chunk.model) doc.capture.model = chunk.model;
  if (message.language && !doc.media.language) doc.media.language = message.language;
  if (known && chunk.status === CHUNK_STATUS.DONE) {
    doc.capture.coverage = addCoverage(doc.capture.coverage, round(start), round(end));
  }

  await putDocument(doc);
  return {};
}

/* ---------- transcript API source (YouTube) ---------- */

/** Videos currently being fetched, so a burst of detections costs one search. */
const inFlight = new Map();

async function fetchForTab(tabId, { force = false } = {}) {
  const media = await askTab(tabId, { type: 'sudosci:media' });
  if (!media) throw new Error('No supported player found in this tab');
  if (media.platform !== 'youtube') {
    throw new Error('The transcript API only covers YouTube — use audio capture here');
  }
  return fetchTranscriptFor(media, { force, tabId });
}

async function fetchTranscriptFor(media, { force = false, tabId = null } = {}) {
  const documentId = `${media.platform}:${media.mediaId}`;

  const existing = await getDocument(documentId);
  if (!force && existing?.capture?.source === SERPAPI_SOURCE && existing.chunks?.length) {
    const doc = await refreshMetadata(existing, media);
    report(tabId, { documentId, cached: true, document: doc });
    // A cached transcript still needs checking if it was never checked.
    void maybeAutoCheck(tabId, documentId);
    return { documentId, cached: true, chunks: doc.chunks.length };
  }

  if (inFlight.has(documentId)) return inFlight.get(documentId);

  const task = (async () => {
    const settings = await getSettings();
    const result = await fetchTranscript({
      videoId: media.mediaId,
      apiKey: settings.serpApiKey,
      languageCode: settings.transcriptLanguage,
      type: settings.transcriptType || undefined,
    });
    const { segments, chapters, languageCode } = result;

    const doc = createDocument({
      media,
      capture: {
        source: SERPAPI_SOURCE,
        sampleRate: null, // no audio involved
        chunkSeconds: CONFIG.chunkSeconds,
        overlapSeconds: 0, // nothing is re-transcribed, so no overlap is needed
        model: SERPAPI_MODEL,
      },
    });

    doc.media.language = languageCode;
    doc.media.chapters = chapters;
    doc.capture.availableTranscripts = result.availableTranscripts;
    doc.capture.availableLanguages = result.availableLanguages;
    doc.capture.transcriptType = result.transcriptType;
    doc.capture.searchId = result.searchId; // traceable in the SerpApi dashboard
    doc.capture.requestedLanguage = settings.transcriptLanguage || null;
    doc.capture.completedAt = new Date().toISOString();
    doc.capture.endsEstimated = result.endsEstimated;
    doc.chunks = chunkSegments(segments, {
      chunkSeconds: CONFIG.chunkSeconds,
      model: SERPAPI_MODEL,
    });

    // Never store an empty document: it would cache as "done" and quietly stand
    // in for a transcript that was never captured.
    if (!doc.chunks.length) {
      throw new Error('Transcript produced no chunks — nothing stored');
    }
    doc.capture.coverage = doc.chunks.reduce(
      (coverage, chunk) => addCoverage(coverage, chunk.start, chunk.end),
      []
    );

    await putDocument(doc);
    report(tabId, { documentId, cached: false, document: doc });
    void maybeAutoCheck(tabId, documentId);

    return {
      documentId,
      cached: false,
      chunks: doc.chunks.length,
      segments: segments.length,
    };
  })().finally(() => inFlight.delete(documentId));

  inFlight.set(documentId, task);
  return task;
}

/* A document stored before the page settled can carry the placeholder title or
   an ad's duration. The transcript is keyed off the video id and stays correct,
   so repair the metadata in place rather than re-fetching. */
async function refreshMetadata(doc, media) {
  let changed = false;

  if (media.title && media.title !== doc.media.title) {
    doc.media.title = media.title;
    changed = true;
  }
  if (media.author && media.author !== doc.media.author) {
    doc.media.author = media.author;
    changed = true;
  }
  // Trust a duration that at least covers the transcript; a shorter one is the
  // stale reading we are trying to correct.
  const transcriptEnd = doc.chunks.length ? doc.chunks[doc.chunks.length - 1].end : 0;
  if (
    Number.isFinite(media.duration) &&
    media.duration >= transcriptEnd - 1 &&
    media.duration !== doc.media.duration
  ) {
    doc.media.duration = media.duration;
    changed = true;
  }

  if (changed) await putDocument(doc);
  return doc;
}

/** Fired by the content script whenever a new video becomes current. */
async function onMediaDetected(media, sender) {
  if (media.platform !== 'youtube') return { skipped: 'not-youtube' };
  const tabId = sender?.tab?.id ?? null;

  const settings = await getSettings();
  if (!settings.autoTranscribe) {
    report(tabId, { note: 'auto-fetch is off — use the popup' });
    return { skipped: 'auto-transcribe-off' };
  }
  if (!settings.serpApiKey) {
    report(tabId, { error: 'No SerpApi key set — add one in the extension popup' });
    return { skipped: 'no-api-key' };
  }

  try {
    // Each fetch costs a SerpApi search, so this leans on the document cache.
    return await fetchTranscriptFor(
      {
        platform: media.platform,
        mediaId: media.mediaId,
        duration: media.duration,
        title: media.title,
        author: media.author,
        url: media.url ?? sender?.tab?.url,
      },
      { tabId }
    );
  } catch (error) {
    const message = String(error?.message || error);
    report(tabId, { error: message });
    return { skipped: 'error', error: message };
  }
}

/* Echo the result into the video tab's console, so the transcript is visible
   where you are already looking instead of buried in extension storage. */
function report(tabId, payload) {
  if (payload.document) {
    const doc = payload.document;
    console.log(
      `[SudoSci] ${payload.cached ? 'cached' : 'fetched'} ${doc.documentId}:`,
      `${doc.chunks.length} chunks,`,
      `${doc.chunks.reduce((n, c) => n + c.segments.length, 0)} segments`
    );
  } else if (payload.error) {
    console.warn('[SudoSci]', payload.error);
  }

  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'sudosci:transcript', ...payload }).catch(() => {});
}

/** Keys never leave the worker; the popup only needs to know one is set. */
function redact(settings) {
  const key = settings.serpApiKey || '';
  const backendKey = settings.factcheckKey || '';
  return {
    autoTranscribe: settings.autoTranscribe,
    transcriptLanguage: settings.transcriptLanguage,
    hasApiKey: !!key,
    apiKeyHint: key ? `••••${key.slice(-4)}` : '',

    factcheckUrl: settings.factcheckUrl,
    autoFactcheck: settings.autoFactcheck,
    showAllVerdicts: settings.showAllVerdicts,
    hasFactcheckKey: !!backendKey,
    factcheckKeyHint: backendKey ? `••••${backendKey.slice(-4)}` : '',
  };
}

/* ---------- fact-check ---------- */

/** Runs keyed by documentId — the request is long, so never start two. */
const checking = new Map();
/** When each in-flight run began, so a popup opened mid-run shows real elapsed. */
const checkStartedAt = new Map();

/* Auto-checks run one at a time. Browsing through several videos would
   otherwise start a 30–120 s model run for each in parallel and burn the
   request's search budget many times over; queueing keeps that to one at a
   time without silently dropping the later videos. */
const autoQueue = [];
let autoDraining = false;

async function maybeAutoCheck(tabId, documentId) {
  if (!tabId) return;
  const { autoFactcheck } = await getSettings();
  if (!autoFactcheck) return;
  if (await getAnalysis(documentId)) return; // already checked, results are cached
  if (checking.has(documentId)) return;
  if (autoQueue.some((job) => job.documentId === documentId)) return;

  autoQueue.push({ tabId, documentId });
  void drainAutoQueue();
}

async function drainAutoQueue() {
  if (autoDraining) return;
  autoDraining = true;
  try {
    while (autoQueue.length) {
      const job = autoQueue.shift();
      if (await getAnalysis(job.documentId)) continue; // checked while queued

      // The tab may have closed or moved on while this waited its turn; there
      // is no point spending a run on a video nobody is watching any more.
      const media = await askTab(job.tabId, { type: 'sudosci:media' });
      if (!media || `${media.platform}:${media.mediaId}` !== job.documentId) continue;

      try {
        await factcheckForTab(job.tabId);
      } catch {
        // Already surfaced to the page console by factcheckForTab.
      }
    }
  } finally {
    autoDraining = false;
  }
}

async function factcheckForTab(tabId, { force = false, offline = false } = {}) {
  const media = await askTab(tabId, { type: 'sudosci:media' });
  if (!media) throw new Error('No supported player found in this tab');

  const documentId = `${media.platform}:${media.mediaId}`;
  const doc = await getDocument(documentId);
  if (!doc?.chunks?.length) {
    throw new Error('No transcript for this video yet — fetch one first');
  }

  const existing = await getAnalysis(documentId);
  if (!force && existing?.response) {
    notifyClaims(tabId, documentId, existing);
    return { documentId, cached: true, claims: existing.response.claims?.length ?? 0 };
  }

  if (checking.has(documentId)) return checking.get(documentId);

  const task = (async () => {
    const settings = await getSettings();
    const startedAt = Date.now();
    checkStartedAt.set(documentId, startedAt);
    const stopKeepAlive = keepAlive();
    report(tabId, { note: 'Fact-checking — this can take a minute or two…' });

    try {
      const response = await runFactCheck({
        baseUrl: settings.factcheckUrl,
        apiKey: settings.factcheckKey,
        document: doc,
        offline,
      });

      const analysis = {
        documentId,
        checkedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        backendUrl: settings.factcheckUrl,
        response,
      };
      await putAnalysis(analysis);
      notifyClaims(tabId, documentId, analysis);

      return {
        documentId,
        cached: false,
        claims: response.claims?.length ?? 0,
        skipped: response.skipped?.length ?? 0,
        researchEnabled: response.research_enabled !== false,
        elapsedMs: analysis.elapsedMs,
      };
    } catch (error) {
      report(tabId, { error: String(error?.message || error) });
      throw error;
    } finally {
      stopKeepAlive();
    }
  })().finally(() => {
    checking.delete(documentId);
    checkStartedAt.delete(documentId);
  });

  checking.set(documentId, task);
  return task;
}

/* A fact check is a single blocking request of 30–120 s. MV3 evicts an idle
   service worker after ~30 s, and a pending fetch is not reliably counted as
   activity — with the popup closed the worker can be killed mid-request and the
   result lost with no error. Touching an extension API resets the timer. */
function keepAlive(intervalMs = 20_000) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), intervalMs);
  return () => clearInterval(timer);
}

async function factcheckStatus(documentId) {
  const analysis = documentId ? await getAnalysis(documentId) : null;
  const running = documentId ? checking.has(documentId) : checking.size > 0;
  return {
    running,
    // Auto-checks start without the popup, so elapsed time has to come from here.
    startedAt: (documentId ? checkStartedAt.get(documentId) : null) ?? null,
    queued: autoQueue.length,
    analysis: analysis ? summariseAnalysis(analysis) : null,
  };
}

/** Verdicts that get a marker unless the user asks to see everything. */
const FLAGGED_VERDICTS = new Set(['false', 'misleading', 'needs_context']);

function summariseAnalysis(analysis) {
  const response = analysis.response || {};
  const claims = response.claims || [];
  const placed = claims.filter((c) => Number.isFinite(c.start_ms));

  return {
    documentId: analysis.documentId,
    checkedAt: analysis.checkedAt,
    elapsedMs: analysis.elapsedMs,
    total: claims.length,
    // start_ms is dropped when the quote could not be located in the transcript.
    placed: placed.length,
    // How many markers actually get drawn, in each mode — so the popup can say
    // why the timeline is empty instead of leaving the user guessing.
    drawableFlagged: placed.filter((c) => FLAGGED_VERDICTS.has(c.verdict)).length,
    drawableAll: placed.length,
    byVerdict: claims.reduce((acc, c) => {
      acc[c.verdict] = (acc[c.verdict] || 0) + 1;
      return acc;
    }, {}),
    skipped: (response.skipped || []).length,
    researchEnabled: response.research_enabled !== false,
    warnings: response.warnings || [],
    model: response.model ?? null,
    searchesUsed: response.searches_used ?? null,
    summary: response.summary ?? null,
    language: response.language ?? null,
  };
}

/** What the content script needs to draw markers and fill the panel. */
async function claimsFor(documentId) {
  const analysis = await getAnalysis(documentId);
  if (!analysis?.response) return { analysis: null };

  const { showAllVerdicts } = await getSettings();
  return {
    analysis: {
      documentId,
      checkedAt: analysis.checkedAt,
      summary: analysis.response.summary ?? null,
      language: analysis.response.language ?? null,
      warnings: analysis.response.warnings || [],
      researchEnabled: analysis.response.research_enabled !== false,
      claims: analysis.response.claims || [],
      skipped: analysis.response.skipped || [],
    },
    showAllVerdicts,
  };
}

function notifyClaims(tabId, documentId, analysis) {
  const summary = summariseAnalysis(analysis);
  console.log(
    `[SudoSci] fact-check ${documentId}:`,
    `${summary.total} claims (${summary.placed} placed),`,
    JSON.stringify(summary.byVerdict)
  );
  if (tabId) {
    chrome.tabs
      .sendMessage(tabId, { type: 'sudosci:claims', documentId, analysis: analysis.response })
      .catch(() => {});
  }
}

/* ---------- export ---------- */

async function exportDocument(documentId) {
  const id = documentId || session?.documentId;
  const doc = id ? await getDocument(id) : null;
  if (!doc) throw new Error('No transcript to export');

  const json = JSON.stringify(doc, null, 2);
  const safe = doc.documentId.replace(/[^\w.-]+/g, '_');

  // Service workers have no URL.createObjectURL, so the JSON rides in a data URL.
  await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
    filename: `sudosci/${safe}.json`,
    saveAs: false,
  });

  return { documentId: doc.documentId, bytes: json.length };
}

/* ---------- plumbing ---------- */

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio to transcribe spoken claims.',
  });
}

async function askTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null; // no content script in that tab
  }
}

const round = (n) => Math.round(n * 1000) / 1000;

/* Capture cannot outlive the tab it is reading. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) stopCapture();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation replaces the media; the current document is finished.
  if (session?.tabId === tabId && changeInfo.url) stopCapture();
});
