// What the metrognome shim answers: schema v2 results built per query.
export type MetrognomeQuery = { artist: string; title: string; client_ref?: string };
export type MetrognomeScript = (query: MetrognomeQuery) => object | Promise<object>;

const feature = (uncertain: boolean, maturity: string, source: string) => ({
  confidence: uncertain ? 0.2 : 0.9,
  uncertain,
  maturity,
  source,
});

/** A preview heard at this tempo and key; an unsure key is reported but flagged. */
export const hears =
  (bpm: number, key: string, camelot: string, { keyUnsure = false } = {}): MetrognomeScript =>
  (query) => ({
    schema_version: 2,
    status: 'ok',
    query,
    track: { uncertain: false },
    features: {
      tempo: { bpm, ...feature(false, 'validated', 'metrognome/onset-autocorrelation-comb@1') },
      key: { key, camelot, ...feature(keyUnsure, 'provisional', 'metrognome/chroma-edm@1') },
    },
  });
