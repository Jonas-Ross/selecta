// Web Audio plumbing and the page's one player: starting any sound stops the last one.
import { SR } from './engine.js';

let player = null;

// How long a sample takes from the context's clock to the speakers.
export const latency = (ctx) => ctx.outputLatency || ctx.baseLatency || 0;
// When audio scheduled at context time t leaves the speakers, on the page's clock.
export const perfAt = (ctx, t) => performance.now() + (t - ctx.currentTime + latency(ctx)) * 1000;

// Built once per track and reused by every play, whichever context plays it.
export function toBuffer(samples) {
  const buf = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: SR });

  buf.copyToChannel(samples, 0);

  return buf;
}

export function playBuffer(ctx, buffer, at, loop = false) {
  const src = new AudioBufferSourceNode(ctx, { buffer, loop });

  src.connect(ctx.destination);
  src.start(at);

  return src;
}

export const current = () => player;

export function stop() {
  if (!player) return;

  const { ctx, raf, onStop } = player;

  player = null;

  if (raf) cancelAnimationFrame(raf);

  ctx.close();
  onStop();
}

// Each section passes the function that puts its own controls back once it's stopped.
export function play(kind, onStop) {
  stop();
  player = { ctx: new AudioContext(), kind, raf: 0, onStop };

  return player;
}

export const toggle = (kind, start) => (player?.kind === kind ? stop() : start());
