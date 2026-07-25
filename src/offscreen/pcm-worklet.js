/* Pulls mono PCM out of the tab audio graph.
 *
 * The audio thread hands us 128-sample blocks; posting each one would be ~375
 * messages a second, so blocks are batched before crossing to the main thread.
 */

const BATCH_SAMPLES = 8192; // ~170 ms at 48 kHz

class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      this.batch[this.filled++] = sample / channels;

      if (this.filled === BATCH_SAMPLES) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(BATCH_SAMPLES);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('sudosci-pcm', PcmCollector);
