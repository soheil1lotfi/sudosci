/* Audio capture host.
 *
 * Captures the tab's audio, slices it into overlapping windows, resamples each
 * window to the model's rate, runs the transcriber, and posts the resulting
 * text (never the audio) back to the service worker.
 *
 * This document exists only because a service worker cannot hold a MediaStream
 * or an AudioContext.
 */

import { CONFIG } from '../transcription/config.js';
import { Chunker } from './chunker.js';
import { transcribe } from './transcriber.js';

let audioContext = null;
let stream = null;
let workletNode = null;
let sourceNode = null;
let chunker = null;
let captureStartWall = 0;
/** False while the media is paused — a paused tab is silence, not content. */
let active = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  switch (message.type) {
    case 'capture:start':
      start(message.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    case 'capture:stop':
      stop()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    case 'capture:setActive':
      active = !!message.active;
      if (!active) chunker?.reset();
      sendResponse({ ok: true });
      return true;
    default:
      return false;
  }
});

async function start(streamId) {
  if (audioContext) await stop();

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // Native rate here, not the model rate: this graph also carries the audio the
  // user is listening to, and running the whole tab through 16 kHz would be
  // audible. Each window is resampled on its own, just before transcription.
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/pcm-worklet.js'));

  sourceNode = audioContext.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioContext, 'sudosci-pcm', { numberOfOutputs: 0 });
  workletNode.port.onmessage = (event) => {
    if (active) chunker?.push(event.data);
    else chunker?.reset();
  };

  sourceNode.connect(workletNode);
  // tabCapture swallows the tab's audio unless it is piped back out.
  sourceNode.connect(audioContext.destination);

  const sampleRate = audioContext.sampleRate;
  captureStartWall = Date.now();
  chunker = new Chunker({
    sampleRate,
    chunkSeconds: CONFIG.chunkSeconds,
    overlapSeconds: CONFIG.overlapSeconds,
    minTailSeconds: CONFIG.minTailSeconds,
    onWindow: (window) => void handleWindow(window, sampleRate),
  });

  // The tab can end the capture on its own (closed, or sharing revoked).
  stream.getAudioTracks()[0]?.addEventListener('ended', () => {
    send({ type: 'capture:ended' });
    stop();
  });

  send({ type: 'capture:started', sampleRate });
}

async function stop() {
  const context = audioContext;
  audioContext = null;

  chunker?.flush();
  await Promise.all(pending);

  if (workletNode) workletNode.port.onmessage = null;
  workletNode?.disconnect();
  sourceNode?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  await context?.close().catch(() => {});

  workletNode = null;
  sourceNode = null;
  stream = null;
  chunker = null;
}

/** In-flight transcriptions, so stop() does not cut off the last window. */
const pending = new Set();

async function handleWindow({ samples, startSample, index }, sourceRate) {
  const task = transcribeWindow({ samples, startSample, index, sourceRate });
  pending.add(task);
  try {
    await task;
  } finally {
    pending.delete(task);
  }
}

async function transcribeWindow({ samples, startSample, index, sourceRate }) {
  const startWall = captureStartWall + (startSample / sourceRate) * 1000;
  const durationSeconds = samples.length / sourceRate;

  let payload;
  try {
    const audio = await resample(samples, sourceRate, CONFIG.targetSampleRate);
    const result = await transcribe({
      audio,
      sampleRate: CONFIG.targetSampleRate,
      chunkIndex: index,
      durationSeconds,
    });
    payload = {
      segments: result.segments || [],
      text: result.text ?? null,
      language: result.language ?? null,
      model: result.model ?? null,
      metrics: result.metrics ?? null,
    };
  } catch (error) {
    payload = { error: String(error?.message || error) };
  }

  send({
    type: 'capture:chunk',
    index,
    startWall,
    endWall: startWall + durationSeconds * 1000,
    durationSeconds,
    ...payload,
  });
}

/** Let the browser resample — it is anti-aliased, naive JS decimation is not. */
async function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;

  const frames = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const offline = new OfflineAudioContext(1, frames, toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);

  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();

  return (await offline.startRendering()).getChannelData(0);
}

function send(message) {
  chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {});
}
