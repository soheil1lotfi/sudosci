/* Groups timestamped segments into the fixed windows the backend consumes.
 *
 * The audio path chunks first and transcribes second; a transcript API gives
 * the whole thing at once, so it gets chunked here instead. Both paths produce
 * the identical chunk shape — the backend cannot tell them apart.
 */

import { CHUNK_STATUS, createChunk } from './schema.js';

/**
 * @param {Array<{start:number, end:number, text:string|null}>} segments
 * @param {{chunkSeconds:number, model?:string|null}} options
 * @returns {Array} chunks
 */
export function chunkSegments(segments, { chunkSeconds, model = null }) {
  const buckets = new Map();

  for (const segment of segments) {
    if (!Number.isFinite(segment.start)) continue;
    // A segment belongs to the window its start falls in, even if it spills
    // over the boundary — splitting mid-sentence would be worse.
    const window = Math.floor(segment.start / chunkSeconds);
    if (!buckets.has(window)) buckets.set(window, []);
    buckets.get(window).push(segment);
  }

  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((window, index) => {
      const members = buckets.get(window);
      const chunk = createChunk({
        index,
        start: round(Math.min(...members.map((s) => s.start))),
        end: round(Math.max(...members.map((s) => s.end))),
        status: CHUNK_STATUS.DONE,
      });
      chunk.text = members
        .map((s) => s.text)
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      chunk.segments = members.map((s) => ({
        start: round(s.start),
        end: round(s.end),
        text: s.text,
        confidence: null,
        speaker: null,
      }));
      chunk.model = model;
      return chunk;
    });
}

const round = (n) => Math.round(n * 1000) / 1000;
