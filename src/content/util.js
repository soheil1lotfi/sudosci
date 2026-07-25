/* Shared helpers. Content scripts run in an isolated world, so a single
   global namespace is enough to wire the files together. */
(() => {
  const NS = (window.__SUDOSCI ||= {});

  const PREFIX = 'sudosci';

  /* Mirrors the backend's Verdict enum. `marker: true` are the verdicts worth
     interrupting a viewer for; the rest only appear when the user asks. */
  const VERDICTS = {
    false: { label: 'False', color: '#ff3b30', marker: true },
    misleading: { label: 'Misleading', color: '#ff9f0a', marker: true },
    needs_context: { label: 'Needs context', color: '#5ac8fa', marker: true },
    unverifiable: { label: 'Unverifiable', color: '#8e8e93', marker: false },
    supported: { label: 'Supported', color: '#30d158', marker: false },
    opinion: { label: 'Opinion', color: '#bf5af2', marker: false },
  };

  const UNKNOWN_VERDICT = { label: 'Unknown', color: '#8e8e93', marker: false };

  const verdictOf = (verdict) => VERDICTS[verdict] || UNKNOWN_VERDICT;

  /* Citation vocabulary, also straight from the backend enums. */
  const STANCES = {
    supports: { label: 'Supports', color: '#30d158' },
    refutes: { label: 'Refutes', color: '#ff3b30' },
    partial: { label: 'Partial', color: '#ff9f0a' },
    context: { label: 'Context', color: '#5ac8fa' },
  };

  const SOURCE_TIERS = {
    systematic_review: 'Systematic review',
    peer_reviewed: 'Peer reviewed',
    preprint: 'Preprint',
    fact_check: 'Fact check',
    institutional: 'Institutional',
    reputable_press: 'Reputable press',
    science_journalism: 'Science journalism',
    other: 'Other',
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
    VERDICTS,
    STANCES,
    SOURCE_TIERS,
    verdictOf,
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
