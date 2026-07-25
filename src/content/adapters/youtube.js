/* YouTube adapter.
 *
 * An adapter tells the rest of the extension four things:
 *   - is this page a supported player right now (`match`)
 *   - which element is the timeline to decorate (`getTimeline`)
 *   - what is playing and how long is it (`getMedia`)
 *   - how to pause / seek (`pause`, `seek`)
 */
(() => {
  const NS = window.__SUDOSCI;

  const youtube = {
    id: 'youtube',
    name: 'YouTube',

    match() {
      return /(^|\.)youtube\.com$/.test(location.hostname);
    },

    /** The bar we hang markers on. Also covers Shorts, which uses its own bar. */
    getTimeline() {
      return (
        document.querySelector('.ytp-progress-bar-container') ||
        document.querySelector('#progress-bar-container') ||
        document.querySelector('.ytPlayerProgressBarHost')
      );
    },

    getVideo() {
      return (
        document.querySelector('.html5-main-video') ||
        document.querySelector('video')
      );
    },

    getMedia() {
      const video = this.getVideo();
      if (!video) return null;

      const duration = Number.isFinite(video.duration) ? video.duration : NaN;
      const url = new URL(location.href);
      const mediaId =
        url.searchParams.get('v') ||
        (location.pathname.startsWith('/shorts/')
          ? location.pathname.split('/')[2]
          : null) ||
        location.pathname;

      return { platform: 'youtube', mediaId, duration, currentTime: video.currentTime };
    },

    /** Playhead sample used to align captured audio to the media timeline. */
    getPlaybackState() {
      const video = this.getVideo();
      if (!video) return null;
      return {
        mediaTime: video.currentTime,
        paused: video.paused,
        rate: video.playbackRate || 1,
      };
    },

    getMetadata() {
      const title =
        document.querySelector('h1.ytd-watch-metadata, h1.title yt-formatted-string')
          ?.textContent?.trim() ||
        document.title.replace(/\s*-\s*YouTube$/, '').trim() ||
        null;
      const author =
        document.querySelector('#owner #channel-name a, ytd-channel-name a')
          ?.textContent?.trim() || null;
      return { title, author, url: location.href };
    },

    pause() {
      const video = this.getVideo();
      if (video && !video.paused) video.pause();
    },

    seek(seconds) {
      const video = this.getVideo();
      if (video) video.currentTime = seconds;
    },

    /** Fires whenever the player might have changed (SPA nav, new video). */
    onMediaChange(callback) {
      const events = ['yt-navigate-finish', 'yt-player-updated'];
      events.forEach((e) => document.addEventListener(e, callback, true));

      const video = this.getVideo();
      if (video) {
        video.addEventListener('loadedmetadata', callback);
        video.addEventListener('durationchange', callback);
      }

      return () => {
        events.forEach((e) => document.removeEventListener(e, callback, true));
        if (video) {
          video.removeEventListener('loadedmetadata', callback);
          video.removeEventListener('durationchange', callback);
        }
      };
    },
  };

  (NS.adapters ||= []).push(youtube);
})();
