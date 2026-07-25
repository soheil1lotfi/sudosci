/* Maps wall-clock time onto media time.
 *
 * The capture side only knows how many samples it has read; it has no idea
 * where the playhead is. The content script reports the playhead a couple of
 * times a second, and this turns "sample 1,440,000" into "27:13 into the
 * episode" — correctly, even across pauses, seeks and 1.5× playback.
 */

import { CONFIG } from '../transcription/config.js';

const MAX_TICKS = 1200; // ~10 minutes at 500 ms

export class MediaClock {
  constructor() {
    /** @type {{wall:number, mediaTime:number, paused:boolean, rate:number}[]} */
    this.ticks = [];
  }

  addTick(tick) {
    this.ticks.push(tick);
    if (this.ticks.length > MAX_TICKS) this.ticks.splice(0, this.ticks.length - MAX_TICKS);
  }

  get latest() {
    return this.ticks[this.ticks.length - 1] || null;
  }

  /** @returns {number|null} media time in seconds at the given wall-clock ms. */
  toMediaTime(wall) {
    const ticks = this.ticks;
    if (!ticks.length) return null;

    if (wall <= ticks[0].wall) {
      return extrapolate(ticks[0], wall);
    }
    if (wall >= ticks[ticks.length - 1].wall) {
      return extrapolate(ticks[ticks.length - 1], wall);
    }

    // Bracket the timestamp and interpolate between the two ticks.
    let lo = 0;
    let hi = ticks.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid].wall <= wall) lo = mid;
      else hi = mid;
    }

    const a = ticks[lo];
    const b = ticks[hi];
    const span = b.wall - a.wall;
    if (span <= 0) return a.mediaTime;

    // A seek between the two ticks makes interpolation meaningless — anchor to
    // the nearer sample instead of inventing a ramp across the jump.
    if (isJump(a, b)) return wall - a.wall < b.wall - wall ? a.mediaTime : b.mediaTime;

    const ratio = (wall - a.wall) / span;
    return a.mediaTime + (b.mediaTime - a.mediaTime) * ratio;
  }

  /** Did the playhead jump (seek) anywhere inside this wall-clock window? */
  hasDiscontinuity(fromWall, toWall) {
    for (let i = 1; i < this.ticks.length; i++) {
      const a = this.ticks[i - 1];
      const b = this.ticks[i];
      // Strict overlap: a jump landing exactly on the boundary belongs to the
      // previous window, not this one.
      if (b.wall <= fromWall || a.wall >= toWall) continue;
      if (isJump(a, b)) return true;
    }
    return false;
  }

  /** Fraction of the window during which the media was paused (0–1). */
  pausedRatio(fromWall, toWall) {
    const total = toWall - fromWall;
    if (total <= 0) return 0;

    let paused = 0;
    for (let i = 1; i < this.ticks.length; i++) {
      const a = this.ticks[i - 1];
      const b = this.ticks[i];
      const overlap = Math.min(toWall, b.wall) - Math.max(fromWall, a.wall);
      if (overlap > 0 && a.paused) paused += overlap;
    }
    return paused / total;
  }

  clear() {
    this.ticks = [];
  }
}

function extrapolate(tick, wall) {
  if (tick.paused) return tick.mediaTime;
  const rate = Number.isFinite(tick.rate) && tick.rate > 0 ? tick.rate : 1;
  return Math.max(0, tick.mediaTime + ((wall - tick.wall) / 1000) * rate);
}

function isJump(a, b) {
  const rate = a.paused ? 0 : (Number.isFinite(a.rate) && a.rate > 0 ? a.rate : 1);
  const expected = ((b.wall - a.wall) / 1000) * rate;
  return Math.abs(b.mediaTime - a.mediaTime - expected) > CONFIG.seekToleranceSeconds;
}
