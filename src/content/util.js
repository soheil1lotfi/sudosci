/* Shared helpers. Content scripts run in an isolated world, so a single
   global namespace is enough to wire the files together. */
(() => {
  const NS = (window.__SUDOSCI ||= {});

  const PREFIX = 'sudosci';

  const SEVERITY = {
    false: { label: 'False', color: '#ff3b30' },
    misleading: { label: 'Misleading', color: '#ff9f0a' },
    unverified: { label: 'Unverified', color: '#5ac8fa' },
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    seekOnClick: true,
    pauseOnClick: true,
  };

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  /** Parse "3:41" / "1:02:07" into seconds. Returns NaN when unparseable. */
  function parseTime(text) {
    if (!text) return NaN;
    const parts = String(text).trim().split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  /** Poll until `fn()` returns something truthy, then resolve with it. */
  function waitFor(fn, { timeout = 15000, interval = 250 } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let value;
        try {
          value = fn();
        } catch {
          value = null;
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  /** Deterministic 32-bit hash — keeps mock claims stable per media id. */
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function getSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  Object.assign(NS, {
    PREFIX,
    SEVERITY,
    DEFAULT_SETTINGS,
    el,
    clamp,
    formatTime,
    parseTime,
    waitFor,
    debounce,
    hashString,
    mulberry32,
    getSettings,
  });
})();
