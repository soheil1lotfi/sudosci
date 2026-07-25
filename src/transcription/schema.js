/* The transcript document — this is the artifact handed to the backend.
 *
 * One document per media item. Chunks are appended as they are produced, so a
 * document is readable (and shippable) while capture is still running.
 */

export const SCHEMA_VERSION = 1;

export const CHUNK_STATUS = {
  PENDING: 'pending',
  DONE: 'done',
  ERROR: 'error',
  SKIPPED: 'skipped', // captured while paused / no speech detected
};

export function createDocument({ media, capture }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    documentId: `${media.platform}:${media.mediaId}`,
    media: {
      platform: media.platform,
      mediaId: media.mediaId,
      url: media.url ?? null,
      title: media.title ?? null,
      author: media.author ?? null,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      language: media.language ?? null, // filled by the model when it detects one
    },
    capture: {
      source: capture.source, // 'tab-audio' | 'caption-track' | ...
      sampleRate: capture.sampleRate,
      chunkSeconds: capture.chunkSeconds,
      overlapSeconds: capture.overlapSeconds,
      model: capture.model,
      startedAt: new Date().toISOString(),
      completedAt: null,
      // Media-time intervals actually captured. Realtime capture means this is
      // only the part the user played — the backend must not assume full
      // coverage.
      coverage: [],
    },
    chunks: [],
  };
}

export function createChunk({ index, start, end, status = CHUNK_STATUS.PENDING }) {
  return {
    index,
    start, // media time, seconds
    end, // media time, seconds
    status,
    text: null,
    segments: [], // [{ start, end, text, confidence, speaker }]
    metrics: null, // { rms, speechRatio } — capture-side signal quality
    model: null,
    discontinuous: false, // a seek happened inside this window
    error: null,
  };
}

export function createSegment({ start, end, text = null, confidence = null, speaker = null }) {
  return { start, end, text, confidence, speaker };
}

/* Gaps this small are pauses between caption cues, not untranscribed audio.
   Merging across them keeps coverage a statement about what was captured
   instead of a list of every breath the speaker took. */
const COVERAGE_GAP_TOLERANCE = 3;

/** Merge overlapping coverage intervals so the list stays small and sorted. */
export function addCoverage(coverage, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return coverage;

  const merged = [...coverage, [start, end]].sort((a, b) => a[0] - b[0]);
  const out = [merged[0]];
  for (const [s, e] of merged.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1] + COVERAGE_GAP_TOLERANCE) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Cheap shape check — catches a malformed model response before it is stored. */
export function validateSegments(segments) {
  if (!Array.isArray(segments)) return 'segments must be an array';
  for (const [i, s] of segments.entries()) {
    if (!s || typeof s !== 'object') return `segment ${i} is not an object`;
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) return `segment ${i} has non-numeric start/end`;
    if (s.end < s.start) return `segment ${i} ends before it starts`;
    if (s.text != null && typeof s.text !== 'string') return `segment ${i} text must be a string or null`;
  }
  return null;
}
