/* ─────────────────────────────────────────────────────────────────────────
 * THE MODEL SEAM. This is the file you replace.
 *
 * It runs inside the offscreen document, which is where the audio already
 * lives — so a local model (transformers.js / whisper.cpp wasm / WebGPU) can
 * run here directly, and a hosted model is just a fetch() from here. Either
 * way no audio crosses a message boundary; only text comes back.
 *
 * Contract — `transcribe(request)` resolves to:
 *
 *   {
 *     segments: [{ start, end, text, confidence, speaker }],  // CHUNK-RELATIVE seconds
 *     text: string | null,        // whole-chunk text, if the model gives one
 *     language: string | null,    // detected, e.g. 'en'
 *     model: string,              // identifier stored on the chunk
 *   }
 *
 * Segment times are relative to the start of the chunk (0 = chunk start).
 * The pipeline shifts them onto the media timeline — do not do it here.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} TranscribeRequest
 * @property {Float32Array} audio      mono PCM, normalised to [-1, 1]
 * @property {number} sampleRate       always CONFIG.targetSampleRate (16000)
 * @property {number} chunkIndex
 * @property {number} durationSeconds
 */

export const MODEL_ID = 'stub-vad-v0';

/**
 * Placeholder implementation: no model, so it runs energy-based voice-activity
 * detection and emits correctly-shaped segments with `text: null`. That proves
 * the audio path end to end (the numbers move when there is real sound) and
 * produces the exact JSON the backend will receive.
 *
 * @param {TranscribeRequest} request
 */
export async function transcribe({ audio, sampleRate, durationSeconds }) {
  const { segments, rms, speechRatio } = detectSpeech(audio, sampleRate);

  return {
    segments: segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: null, // ← the model fills this in
      confidence: null,
      speaker: null,
    })),
    text: null,
    language: null,
    model: MODEL_ID,
    metrics: { rms, speechRatio, durationSeconds },
  };
}

/* ---------- placeholder VAD (delete along with the stub) ---------- */

const FRAME_SECONDS = 0.03;
const SILENCE_FLOOR = 0.006; // RMS below this is treated as silence
const MIN_SPEECH_SECONDS = 0.4;
const BRIDGE_GAP_SECONDS = 0.35; // join segments separated by less than this

function detectSpeech(audio, sampleRate) {
  const frameSize = Math.max(1, Math.round(FRAME_SECONDS * sampleRate));
  const frames = [];
  let total = 0;

  for (let i = 0; i < audio.length; i += frameSize) {
    let sum = 0;
    const end = Math.min(i + frameSize, audio.length);
    for (let j = i; j < end; j++) sum += audio[j] * audio[j];
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    frames.push(rms);
    total += rms;
  }

  const segments = [];
  let open = null;
  frames.forEach((rms, i) => {
    const t = (i * frameSize) / sampleRate;
    if (rms >= SILENCE_FLOOR) {
      if (!open) open = { start: t, end: t + FRAME_SECONDS };
      else open.end = t + FRAME_SECONDS;
    } else if (open && t - open.end > BRIDGE_GAP_SECONDS) {
      segments.push(open);
      open = null;
    }
  });
  if (open) segments.push(open);

  const speech = segments.filter((s) => s.end - s.start >= MIN_SPEECH_SECONDS);
  const speechSeconds = speech.reduce((acc, s) => acc + (s.end - s.start), 0);
  const duration = audio.length / sampleRate;

  return {
    segments: speech,
    rms: Number((total / Math.max(1, frames.length)).toFixed(5)),
    speechRatio: Number((speechSeconds / Math.max(0.001, duration)).toFixed(3)),
  };
}
