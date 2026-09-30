// Vitest setup: tests must never reach live endpoints. Global fetch is the
// codebase's only web-egress primitive (src/enrich/ reaches it solely via the
// engine's `deps.fetchLike ?? withUserAgent(fetch)` default), so replacing it
// makes network access in tests structurally impossible instead of a
// convention: any test that forgets to inject a FetchLike fails loudly right
// here rather than silently querying MusicBrainz/AcousticBrainz/Deezer.
// (The integration suite talks to Music.app via osascript — no fetch — so
// this guard applies to every suite.)

globalThis.fetch = (async (input: unknown) => {
  throw new Error(
    `network egress blocked in tests: fetch(${String(input)}) — inject a FetchLike (see test/enrich.test.ts fakeFetch)`,
  );
}) as typeof fetch;
