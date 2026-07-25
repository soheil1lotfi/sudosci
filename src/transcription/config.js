/* Capture + chunking parameters. */

export const CONFIG = {
  /** Length of one transcription window, in seconds. */
  chunkSeconds: 30,

  /** Overlap between consecutive windows. Keeps words from being cut in half;
   *  the backend de-duplicates the repeated span. */
  overlapSeconds: 2,

  /** What the model is fed. 16 kHz mono is what most speech models expect. */
  targetSampleRate: 16000,

  /** Shortest tail worth emitting when capture stops mid-window. */
  minTailSeconds: 3,

  /** How often the content script reports the playhead, in ms. */
  clockTickMs: 500,

  /** A jump larger than this between two ticks is treated as a seek. */
  seekToleranceSeconds: 1.5,
};
