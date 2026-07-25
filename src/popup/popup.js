const DEFAULTS = { enabled: true, seekOnClick: true, pauseOnClick: true };
const TOGGLES = ['enabled', 'pauseOnClick', 'seekOnClick'];

const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Ask the content script what it sees. Returns null when it isn't there. */
async function ask(message) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null; // no content script on this page
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function refreshStatus() {
  const status = await ask({ type: 'sudosci:status' });
  if (!status) {
    statusEl.textContent = 'No player here';
    statusEl.classList.remove('active');
    detailEl.textContent = 'Open a YouTube video';
    return;
  }
  statusEl.textContent = status.platform;
  statusEl.classList.toggle('active', status.mounted);
  detailEl.textContent = `${status.markers} marker${status.markers === 1 ? '' : 's'} · ${formatDuration(status.duration)}`;
}

/* ---------- transcription ---------- */

const stateEl = document.getElementById('captureState');
const sourceEl = document.getElementById('captureSource');
const statsEl = document.getElementById('captureStats');
const fetchEl = document.getElementById('fetchTranscript');
const toggleEl = document.getElementById('captureToggle');
const exportEl = document.getElementById('exportJson');
const hintEl = document.getElementById('captureHint');
const autoEl = document.getElementById('autoTranscribe');
const keyEl = document.getElementById('apiKey');
const saveKeyEl = document.getElementById('saveKey');

let capturing = false;
let documentId = null;
let onYouTube = false;
let hasApiKey = false;

function toBackground(message) {
  return chrome.runtime.sendMessage({ target: 'background', ...message });
}

function renderCapture(status, media) {
  capturing = !!status?.capturing;
  const doc = status?.document || null;
  documentId = doc?.documentId ?? null;
  onYouTube = media?.platform === 'youtube';

  stateEl.textContent = capturing ? 'recording' : doc ? 'ready' : 'idle';
  stateEl.classList.toggle('live', capturing);

  sourceEl.textContent = !onYouTube
    ? 'No video in this tab'
    : doc?.source === 'tab-audio' || capturing
      ? 'Source: tab audio → local model'
      : 'Source: YouTube transcript (SerpApi)';

  fetchEl.disabled = !onYouTube || capturing;
  toggleEl.textContent = capturing
    ? 'Stop audio capture'
    : 'No captions? Capture audio instead';
  toggleEl.classList.toggle('recording', capturing);
  toggleEl.disabled = !onYouTube;
  exportEl.disabled = !documentId;

  if (doc) {
    const mins = Math.floor(doc.coveredSeconds / 60);
    const secs = doc.coveredSeconds % 60;
    statsEl.textContent =
      `${doc.chunks} chunk${doc.chunks === 1 ? '' : 's'} · ` +
      `${doc.segments} segment${doc.segments === 1 ? '' : 's'} · ` +
      `${mins}:${String(secs).padStart(2, '0')} covered` +
      (doc.errors ? ` · ${doc.errors} error${doc.errors === 1 ? '' : 's'}` : '');
  } else {
    statsEl.textContent = 'Nothing transcribed yet';
  }

  if (!hintEl.dataset.sticky) {
    hintEl.textContent = capturing
      ? 'Capturing in realtime — only what plays gets transcribed.'
      : onYouTube && !hasApiKey
        ? 'Add a SerpApi key to fetch transcripts.'
        : '';
  }
}

function say(text) {
  hintEl.textContent = text;
  hintEl.dataset.sticky = '1';
  clearTimeout(say.timer);
  say.timer = setTimeout(() => delete hintEl.dataset.sticky, 6000);
}

async function refreshCapture() {
  const tab = await activeTab();
  const [status, media] = await Promise.all([
    toBackground({ type: 'transcribe:status', tabId: tab?.id }).catch(() => null),
    ask({ type: 'sudosci:media' }),
  ]);
  renderCapture(status, media);
  // The fact-check section keys off documentId, which was just resolved.
  if (typeof refreshCheck === 'function' && !checking) refreshCheck();

  // The document grows while an audio capture runs.
  clearTimeout(refreshCapture.timer);
  if (capturing) refreshCapture.timer = setTimeout(refreshCapture, 2000);
}

async function initCapture() {
  const { settings } = (await toBackground({ type: 'settings:get' }).catch(() => ({}))) || {};
  if (settings) {
    hasApiKey = settings.hasApiKey;
    autoEl.checked = !!settings.autoTranscribe;
    keyEl.placeholder = settings.hasApiKey ? `SerpApi key ${settings.apiKeyHint}` : 'SerpApi key';
  }

  autoEl.addEventListener('change', () => {
    toBackground({ type: 'settings:set', patch: { autoTranscribe: autoEl.checked } });
  });

  saveKeyEl.addEventListener('click', async () => {
    const value = keyEl.value.trim();
    if (!value) return;
    const res = await toBackground({ type: 'settings:set', patch: { serpApiKey: value } });
    hasApiKey = !!res?.settings?.hasApiKey;
    keyEl.value = '';
    keyEl.placeholder = `SerpApi key ${res?.settings?.apiKeyHint || ''}`;
    say('API key saved');
  });

  fetchEl.addEventListener('click', async () => {
    fetchEl.disabled = true;
    try {
      say('Fetching transcript…');
      const tab = await activeTab();
      const res = await toBackground({ type: 'transcript:fetch', tabId: tab?.id });
      say(
        res?.ok
          ? res.cached
            ? `Already stored — ${res.chunks} chunks`
            : `Fetched ${res.segments} segments → ${res.chunks} chunks`
          : res?.error || 'Fetch failed'
      );
    } finally {
      fetchEl.disabled = false;
      refreshCapture();
    }
  });

  // Fallback for videos with no caption track: transcribe the audio instead.
  toggleEl.addEventListener('click', async () => {
    toggleEl.disabled = true;
    try {
      if (capturing) {
        await toBackground({ type: 'transcribe:stop' });
      } else {
        const tab = await activeTab();
        const res = await toBackground({ type: 'transcribe:start', tabId: tab?.id });
        if (!res?.ok) say(res?.error || 'Could not start capture');
      }
    } finally {
      toggleEl.disabled = false;
      refreshCapture();
    }
  });

  exportEl.addEventListener('click', async () => {
    const res = await toBackground({ type: 'transcribe:export', documentId });
    say(
      res?.ok
        ? `Saved ${(res.bytes / 1024).toFixed(1)} KB to Downloads/sudosci/`
        : res?.error || 'Nothing to export'
    );
  });

  refreshCapture();
}

/* ---------- fact check ---------- */

const checkStateEl = document.getElementById('checkState');
const checkStatsEl = document.getElementById('checkStats');
const runCheckEl = document.getElementById('runCheck');
const pingEl = document.getElementById('pingBackend');
const checkHintEl = document.getElementById('checkHint');
const autoCheckEl = document.getElementById('autoFactcheck');
const showAllEl = document.getElementById('showAllVerdicts');
const urlEl = document.getElementById('backendUrl');
const keyEl2 = document.getElementById('backendKey');
const saveBackendEl = document.getElementById('saveBackend');

let checking = false;
let checkStartedAt = 0;

function sayCheck(text) {
  checkHintEl.textContent = text;
}

function renderCheck(status) {
  checking = !!status?.running;
  const a = status?.analysis || null;

  checkStateEl.textContent = checking ? 'checking' : a ? 'done' : 'idle';
  checkStateEl.classList.toggle('live', checking);
  runCheckEl.textContent = a && !checking ? 'Re-check claims' : 'Check claims';
  runCheckEl.disabled = checking || !documentId;

  if (checking) {
    // No streaming from the backend, so the only honest progress is elapsed
    // time. The run may have been started automatically before the popup was
    // opened, so prefer the background's start time over ours.
    const since = status?.startedAt || checkStartedAt || Date.now();
    const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
    checkStatsEl.textContent = `Working… ${secs}s (can take 30–120s)`;
    return;
  }

  if (!a) {
    checkStatsEl.textContent = documentId ? 'Not checked yet' : 'Needs a transcript first';
    return;
  }

  const counts = Object.entries(a.byVerdict)
    .sort((x, y) => y[1] - x[1])
    .map(([verdict, n]) => `${n} ${verdict.replace('_', ' ')}`)
    .join(' · ');
  checkStatsEl.textContent =
    `${a.total} claim${a.total === 1 ? '' : 's'}` +
    (a.total - a.placed > 0 ? ` (${a.total - a.placed} without a timestamp)` : '') +
    (counts ? ` — ${counts}` : '');

  /* A run that draws no markers looks like a failure after a minute of waiting,
     so name the reason. Most specific explanation wins. */
  const drawn = showAllEl.checked ? a.drawableAll : a.drawableFlagged;
  const seeTheRest = showAllEl.checked
    ? ''
    : ' Tick "Mark every claim" to see them.';

  if (!a.researchEnabled) {
    // Without research every verdict is `unverifiable`, which is not a marker.
    sayCheck(`⚠ Search was unavailable, so every verdict is unverifiable.${seeTheRest}`);
  } else if (a.total === 0) {
    sayCheck('No checkable claims were found in this transcript.');
  } else if (drawn === 0 && a.placed === 0) {
    sayCheck(
      `No marker: the quote${a.total === 1 ? '' : 's'} could not be located in the ` +
        'transcript, so there is no timestamp to place.'
    );
  } else if (drawn === 0) {
    sayCheck(`Nothing flagged — no false or misleading claims found.${seeTheRest}`);
  } else if (a.warnings?.length) {
    sayCheck(a.warnings.join(' · '));
  }
}

async function refreshCheck() {
  const status = await toBackground({
    type: 'factcheck:status',
    documentId,
  }).catch(() => null);
  renderCheck(status);

  clearTimeout(refreshCheck.timer);
  if (checking) {
    refreshCheck.timer = setTimeout(refreshCheck, 1000);
  } else if (documentId && !status?.analysis) {
    // An automatic check may be about to start, or be queued behind another
    // video; keep looking so the popup does not sit on a stale "idle".
    refreshCheck.timer = setTimeout(refreshCheck, 2500);
  }
}

async function initFactcheck() {
  const { settings } = (await toBackground({ type: 'settings:get' }).catch(() => ({}))) || {};
  if (settings) {
    autoCheckEl.checked = !!settings.autoFactcheck;
    showAllEl.checked = !!settings.showAllVerdicts;
    urlEl.value = settings.factcheckUrl || '';
    keyEl2.placeholder = settings.hasFactcheckKey
      ? `Backend key ${settings.factcheckKeyHint}`
      : 'Backend API key (optional)';
  }

  autoCheckEl.addEventListener('change', () =>
    toBackground({ type: 'settings:set', patch: { autoFactcheck: autoCheckEl.checked } })
  );
  showAllEl.addEventListener('change', async () => {
    await toBackground({ type: 'settings:set', patch: { showAllVerdicts: showAllEl.checked } });
    // Markers are rebuilt from the stored analysis, so nudge the page.
    await ask({ type: 'sudosci:refresh' });
  });

  saveBackendEl.addEventListener('click', async () => {
    const patch = { factcheckUrl: urlEl.value.trim() };
    if (keyEl2.value.trim()) patch.factcheckKey = keyEl2.value.trim();

    // A custom host needs its permission granted; this click is the gesture.
    const granted = await ensureHostPermission(patch.factcheckUrl);
    if (!granted) return sayCheck('Permission for that host was declined');

    const res = await toBackground({ type: 'settings:set', patch });
    keyEl2.value = '';
    if (res?.settings?.hasFactcheckKey) {
      keyEl2.placeholder = `Backend key ${res.settings.factcheckKeyHint}`;
    }
    sayCheck('Backend saved');
  });

  pingEl.addEventListener('click', async () => {
    sayCheck('Pinging…');
    const res = await toBackground({ type: 'factcheck:ping' }).catch(() => null);
    const b = res?.backend;

    if (!b) return sayCheck('Could not reach the extension background');
    if (!b.ok && !b.status) return sayCheck(`Unreachable — ${b.error}`);
    if (!b.ok) return sayCheck(`Not ready (HTTP ${b.status}) — model still loading?`);

    // Research down is not an error, but it changes what a run is worth.
    const research =
      b.researchConfigured === false
        ? 'research not configured — every verdict will be unverifiable'
        : b.researchOk
          ? `research ok (${b.researchTools} tools)`
          : `research unreachable — verdicts will be unverifiable${b.researchError ? `: ${b.researchError}` : ''}`;
    sayCheck(`Ready · ${b.model || 'model'} · ${research}`);
  });

  runCheckEl.addEventListener('click', async () => {
    runCheckEl.disabled = true;
    checking = true;
    checkStartedAt = Date.now();
    renderCheck({ running: true });
    sayCheck('');

    const tab = await activeTab();
    const res = await toBackground({
      type: 'factcheck:run',
      tabId: tab?.id,
      force: true,
    }).catch((error) => ({ ok: false, error: String(error?.message || error) }));

    checking = false;
    if (!res?.ok) sayCheck(res?.error || 'Fact check failed');
    else if (res.cached) sayCheck(`Already checked — ${res.claims} claims`);
    else sayCheck(`Done in ${Math.round((res.elapsedMs || 0) / 1000)}s — ${res.claims} claims`);
    refreshCheck();
  });

  refreshCheck();
}

/** Custom backend hosts are optional permissions, granted on demand. */
async function ensureHostPermission(url) {
  if (!url) return true;
  let origin;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    sayCheck('That does not look like a URL');
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function init() {
  initCapture();
  initFactcheck();

  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };

  for (const key of TOGGLES) {
    const input = document.getElementById(key);
    input.checked = !!settings[key];
    input.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: input.checked });
      setTimeout(refreshStatus, 300);
    });
  }

  document.getElementById('refresh').addEventListener('click', async () => {
    await ask({ type: 'sudosci:refresh' });
    setTimeout(refreshStatus, 400);
  });

  refreshStatus();
}

init();
