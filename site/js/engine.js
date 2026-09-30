// The page's side of the metrognome worker: PCM in, a report out.
export const SR = 44100;
// metrognome is tuned and validated on 30-second preview clips.
const WINDOW_SECS = 30;

let worker = null;
let nextId = 0;
const waiting = new Map();

export function engine() {
  if (!worker) {
    worker = new Worker(new URL('worker.js', import.meta.url));

    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);

      waiting.delete(data.id);

      if (data.ok) w.resolve(data);
      else w.reject(new Error(data.error));
    };

    worker.onerror = (e) => {
      for (const w of waiting.values())
        w.reject(new Error(e.message || 'The analysis engine failed to load.'));

      waiting.clear();
    };
  }

  return worker;
}

export function analyze(samples) {
  const id = nextId++;
  const copy = samples.slice();

  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    engine().postMessage({ id, samples: copy, sampleRate: SR }, [copy.buffer]);
  });
}

export async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  // decodeAudioData resamples to the context's rate, so everything reaches the
  // engine at 44.1 kHz whatever the file was.
  const buf = await new OfflineAudioContext(1, 1, SR).decodeAudioData(bytes);
  const mono = new Float32Array(buf.length);

  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);

    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }

  return mono;
}

// The middle of a long track is where it is most itself: past the intro, before the outro.
export function headline(len) {
  const w = WINDOW_SECS * SR;

  if (len <= w) return { start: 0, end: len, long: false };

  const start = Math.floor((len - w) / 2);

  return { start, end: start + w, long: true };
}
