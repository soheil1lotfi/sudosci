/* Controller: picks the adapter for this page, keeps an overlay mounted on the
   player timeline, and refreshes claims whenever the media changes. */
(() => {
  const NS = window.__SUDOSCI;
  const { waitFor, debounce, getSettings } = NS;

  const adapter = (NS.adapters || []).find((a) => a.match());
  if (!adapter) return;

  let settings = { ...NS.DEFAULT_SETTINGS };
  let overlay = null;
  let currentKey = null; // `${mediaId}:${duration}` — identifies what is loaded
  let claimCount = 0;

  function teardown() {
    overlay?.destroy();
    overlay = null;
    currentKey = null;
    claimCount = 0;
  }

  async function sync() {
    if (!settings.enabled) {
      teardown();
      return;
    }

    const media = adapter.getMedia();
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;

    const key = `${media.mediaId}:${Math.round(media.duration)}`;
    const needsRemount = !overlay || !overlay.isAttached();

    if (key === currentKey && !needsRemount) return;

    const container = await waitFor(() => adapter.getTimeline(), { timeout: 20000 });
    if (!container) return;

    // The player may have swapped tracks while we waited for the bar.
    const fresh = adapter.getMedia();
    if (!fresh || `${fresh.mediaId}:${Math.round(fresh.duration)}` !== key) return;

    if (!overlay || overlay.container !== container || !overlay.isAttached()) {
      overlay?.destroy();
      overlay = new NS.TimelineOverlay(container, adapter, settings);
    }

    currentKey = key;
    const claims = await NS.claims.fetchClaims(media);

    // Bail if something else loaded while claims were in flight.
    if (currentKey !== key || !overlay) return;
    claimCount = claims.length;
    overlay.setClaims(claims, media.duration);
  }

  const syncSoon = debounce(sync, 400);

  async function start() {
    settings = await getSettings();

    adapter.onMediaChange(syncSoon);
    window.addEventListener('resize', debounce(() => overlay?.render(), 200));

    // Players re-render their controls freely (fullscreen, theatre mode, track
    // change); a slow heartbeat re-attaches the overlay when that happens.
    setInterval(sync, 2000);
    sync();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    if (overlay) overlay.settings = settings;
    if (!settings.enabled) teardown();
    else sync();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sudosci:status') {
      const media = adapter.getMedia();
      sendResponse({
        platform: adapter.name,
        mediaId: media?.mediaId ?? null,
        duration: media?.duration ?? null,
        markers: claimCount,
        mounted: !!overlay?.isAttached(),
      });
      return true;
    }
    if (msg?.type === 'sudosci:refresh') {
      currentKey = null;
      sync();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  start();
})();
