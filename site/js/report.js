// A metrognome reading in words. A guess always says so.
const maybe = (est) => (est.uncertain ? 'maybe ' : '');

const keyCode = (key) => (key ? `${maybe(key)}${key.camelot}` : 'no key');

export const keyText = (key) => (key ? `${maybe(key)}${key.key}` : 'no key');
export const discSub = (tempo, key) =>
  tempo ? `${tempo.uncertain ? '~' : ''}${Math.round(tempo.bpm)} BPM · ${keyCode(key)}` : 'no beat';
