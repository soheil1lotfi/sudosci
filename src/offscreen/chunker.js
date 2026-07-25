/* Cuts a stream of PCM frames into fixed, overlapping windows.
 *
 * Pure: no Chrome APIs, no audio APIs. It counts samples, which makes window
 * boundaries exact — timing is derived from the sample index rather than from
 * when a message happened to arrive.
 */

export class Chunker {
  /**
   * @param {object} options
   * @param {number} options.sampleRate
   * @param {number} options.chunkSeconds
   * @param {number} options.overlapSeconds
   * @param {number} options.minTailSeconds
   * @param {(window: {samples: Float32Array, startSample: number, index: number}) => void} options.onWindow
   */
  constructor({ sampleRate, chunkSeconds, overlapSeconds, minTailSeconds, onWindow }) {
    this.sampleRate = sampleRate;
    this.windowSamples = Math.round(chunkSeconds * sampleRate);
    this.hopSamples = Math.round((chunkSeconds - overlapSeconds) * sampleRate);
    this.minTailSamples = Math.round(minTailSeconds * sampleRate);
    this.onWindow = onWindow;

    this.queue = [];
    this.queued = 0;
    /** Absolute index (from the first sample ever seen) of queue[0]. */
    this.queueStartSample = 0;
    this.totalSamples = 0;
    this.index = 0;
  }

  push(frame) {
    this.totalSamples += frame.length;
    this.queue.push(frame);
    this.queued += frame.length;

    while (this.queued >= this.windowSamples) {
      this.emit(this.windowSamples);
      this.drop(this.hopSamples);
    }
  }

  /** Discard buffered audio — used when playback pauses, so windows never
   *  straddle a gap in the media timeline. */
  reset() {
    this.queue = [];
    this.queued = 0;
    this.queueStartSample = this.totalSamples;
  }

  /** Emit whatever is left, if there is enough of it to be worth transcribing. */
  flush() {
    if (this.queued >= this.minTailSamples) this.emit(this.queued);
    this.reset();
  }

  emit(count) {
    this.onWindow({
      samples: this.take(count),
      startSample: this.queueStartSample,
      index: this.index++,
    });
  }

  /** Copy the first `count` samples without consuming them. */
  take(count) {
    const out = new Float32Array(count);
    let offset = 0;
    for (const frame of this.queue) {
      if (offset >= count) break;
      const slice = frame.subarray(0, Math.min(frame.length, count - offset));
      out.set(slice, offset);
      offset += slice.length;
    }
    return out;
  }

  /** Consume `count` samples from the front. */
  drop(count) {
    let remaining = count;
    while (remaining > 0 && this.queue.length) {
      const frame = this.queue[0];
      if (frame.length <= remaining) {
        remaining -= frame.length;
        this.queue.shift();
      } else {
        this.queue[0] = frame.subarray(remaining);
        remaining = 0;
      }
    }
    const consumed = count - remaining;
    this.queued -= consumed;
    this.queueStartSample += consumed;
  }
}
