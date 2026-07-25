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

async function init() {
  initCapture();

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
