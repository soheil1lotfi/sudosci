/* Reports the playhead to the service worker during a capture session.
 *
 * Audio capture is a stream of samples with no notion of where it sits in the
 * media; these ticks are what let the background map a captured window onto a
 * timestamp — correctly across pauses, seeks and non-1× playback.
 */
(() => {
  const NS = window.__SUDOSCI;
  const adapter = (NS.adapters || []).find((a) => a.match());
  if (!adapter) return;

  const BADGE = 'background:#5ac8fa;color:#06202b;padding:1px 5px;border-radius:3px;font-weight:600';

  let timer = null;
  let announcedKey = null;
  let lastReading = null;

  function describeMedia() {
    const media = adapter.getMedia();
    if (!media || !media.mediaId) return null;
    const meta = adapter.getMetadata?.() || {};
    return {
      platform: media.platform,
      mediaId: media.mediaId,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      title: meta.title ?? null,
      author: meta.author ?? null,
      url: meta.url ?? location.href,
      isAd: !!media.isAd,
      ready: !!media.ready,
    };
  }

  /* Tell the background when a new media item becomes current, so it can pull
     the transcript. Deliberately independent of the marker settings — a user
     who hid the markers still wants the transcript collected. */
  function announceMedia() {
    const media = describeMedia();
    if (!media) return;

    const key = `${media.platform}:${media.mediaId}`;
    if (key === announcedKey) return;

    // An ad plays through the same <video>, so its duration is not the video's.
    if (media.isAd || !media.ready || !media.duration || !media.title) {
      lastReading = null;
      return;
    }

    /* Require the same reading twice in a row. YouTube is a single-page app:
       on navigation the URL becomes the new video while <video> still holds the
       previous one's duration and the title is still the placeholder, so the
       first reading after a nav is routinely a mix of both videos. */
    const reading = `${key}|${Math.round(media.duration)}|${media.title}`;
    if (reading !== lastReading) {
      lastReading = reading;
      return;
    }

    announcedKey = key;
    chrome.runtime
      .sendMessage({ target: 'background', type: 'media:detected', ...media })
      .catch(() => {});
  }

  function tick() {
    const state = adapter.getPlaybackState?.();
    if (!state || !Number.isFinite(state.mediaTime)) return;
    chrome.runtime
      .sendMessage({
        target: 'background',
        type: 'clock:tick',
        mediaTime: state.mediaTime,
        paused: state.paused,
        rate: state.rate,
      })
      .catch(() => {
        // Worker asleep or session gone — the next tick will find out.
      });
  }

  function startTicking(intervalMs) {
    stopTicking();
    tick();
    timer = setInterval(tick, intervalMs || 500);
  }

  function stopTicking() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case 'sudosci:media':
        sendResponse(describeMedia());
        return true;
      /* Print the transcript in the page console — where you are already
         looking — rather than only in the service worker's. */
      case 'sudosci:transcript': {
        if (message.error) {
          console.warn('%c[SudoSci]%c ' + message.error, BADGE, '');
        } else if (message.note) {
          console.info('%c[SudoSci]%c ' + message.note, BADGE, '');
        } else if (message.document) {
          const doc = message.document;
          const segments = doc.chunks.reduce((n, c) => n + c.segments.length, 0);
          console.groupCollapsed(
            `%c[SudoSci]%c transcript ${message.cached ? '(cached)' : 'fetched'} — ` +
              `${doc.chunks.length} chunks, ${segments} segments`,
            BADGE,
            ''
          );
          console.log('document:', doc);
          console.log('JSON:', JSON.stringify(doc, null, 2));
          console.groupEnd();
        }
        sendResponse({ ok: true });
        return true;
      }
      case 'sudosci:clock:start':
        startTicking(message.intervalMs);
        sendResponse({ ok: true });
        return true;
      case 'sudosci:clock:stop':
        stopTicking();
        sendResponse({ ok: true });
        return true;
      default:
        return false;
    }
  });

  // Watch for the current media changing. Players are single-page apps, so
  // this is a poll rather than a navigation event.
  announceMedia();
  const watcher = setInterval(announceMedia, 2000);

  window.addEventListener('pagehide', () => {
    stopTicking();
    clearInterval(watcher);
  });
})();
