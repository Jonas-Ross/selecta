// External metadata sources, one thin fetch adapter each: build the request,
// gate the response through match.ts, return plain data. Every failure —
// non-OK status, in-body error, unreachable host, unparseable JSON — is
// translated HERE into BridgeError 'enrichment_error' naming the source. No
// retries, no fallbacks: the caller decides what happens next.
//
// Rate limits are honored HERE too, per documented policy, via per-host
// throttles created with the sources (createSources): a throttle starts as if
// a request just happened, so even back-to-back engine runs can't burst a
// host at the boundary.
//   MusicBrainz    1 req/s avg per IP (503 on breach)  → 1.1s spacing
//   AcousticBrainz 10 req per 10s per IP (429)         → 1.1s spacing
//   Deezer         50 req per 5s (in-body quota error) → 250ms spacing
//                  (caps us at 20 per 5s by construction, not by latency luck)

import { BridgeError } from '../types/errors.js';
import { durationCompatible, luceneEscape, primaryArtist, stripFeat } from './match.js';

// MusicBrainz requires an identifying User-Agent; the same one rides every source.
export const USER_AGENT = 'Selecta/0.1 (https://github.com/Jonas-Ross/selecta)';

const MB_SPACING_MS = 1100;
const AB_SPACING_MS = 1100;
const DZ_SPACING_MS = 250;

// Structural fetch so tests inject canned responses; production wraps the
// global fetch via withUserAgent.
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function withUserAgent(fetchImpl: typeof fetch): FetchLike {
  return (url) => fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
}

/** The track fields matching needs; a subset of TrackRow. */
export type MatchTarget = {
  artist: string;
  title: string;
  durationSeconds: number | null;
};

export type SourceDeps = {
  fetchLike: FetchLike;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
};

export type AbFeatures = {
  bpm: number | null;
  musicalKey: string | null;
  danceability: number | null;
};

// Waits out whatever remains of `spacingMs` since the previous throttled
// request to the same host. Wall time already spent on other hosts counts,
// so pacing costs only the true deficit.
function makeThrottle(spacingMs: number, deps: SourceDeps): () => Promise<void> {
  let lastRequestAt = deps.nowMs(); // as-if-just-called: guards run boundaries
  return async () => {
    const wait = spacingMs - (deps.nowMs() - lastRequestAt);
    if (wait > 0) await deps.sleep(wait);
    lastRequestAt = deps.nowMs();
  };
}

/**
 * The three source adapters sharing one fetch and their host throttles.
 * Create once per enrichment run.
 */
export function createSources(deps: SourceDeps) {
  const paceMb = makeThrottle(MB_SPACING_MS, deps);
  const paceAb = makeThrottle(AB_SPACING_MS, deps);
  const paceDz = makeThrottle(DZ_SPACING_MS, deps);

  async function getJson(url: string, source: string): Promise<unknown> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await deps.fetchLike(url);
    } catch (err) {
      throw new BridgeError(
        'enrichment_error',
        `${source} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BridgeError('enrichment_error', `${source} responded ${res.status} for ${url}`);
    }
    try {
      return await res.json();
    } catch {
      throw new BridgeError('enrichment_error', `${source} returned unparseable JSON for ${url}`);
    }
  }

  // ── MusicBrainz: artist+title → recording MBID ──────────────────────────

  // Search scores run 0–100; below this the top hit is usually a different
  // song. Results are score-ordered, so the scan stops at the first sub-gate.
  const MB_MIN_SCORE = 85;

  type MbSearchResponse = {
    recordings?: { id: string; score: number; length?: number }[];
  };

  async function mbFindRecording(target: MatchTarget): Promise<string | null> {
    const query = `recording:"${luceneEscape(stripFeat(target.title))}" AND artist:"${luceneEscape(primaryArtist(target.artist))}"`;
    const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
    await paceMb();
    const data = (await getJson(url, 'MusicBrainz')) as MbSearchResponse;
    for (const rec of data.recordings ?? []) {
      if (rec.score < MB_MIN_SCORE) break;
      if (durationCompatible(rec.length != null ? rec.length / 1000 : null, target.durationSeconds)) {
        return rec.id;
      }
    }
    return null;
  }

  // ── AcousticBrainz: MBIDs → bpm / key / danceability ────────────────────
  // Archive frozen since early 2022 — an MBID absent from the response is the
  // normal "no data" case for recent releases, not a failure. Only the BULK
  // endpoints are usable: measured live, per-MBID GETs take ~60s while a bulk
  // lookup answers in a few seconds regardless of ID count, so features are
  // fetched per 25-MBID chunk (the endpoint's max).

  const AB_BULK_MAX = 25;

  type AbLowLevel = { rhythm?: { bpm?: number }; tonal?: { key_key?: string; key_scale?: string } };
  type AbHighLevel = { highlevel?: { danceability?: { all?: { danceable?: number } } } };
  // Bulk responses key by MBID, then by submission offset — "0" is the first.
  type AbBulk<T> = Record<string, Record<string, T>>;

  async function abLookupFeatures(mbids: string[]): Promise<Map<string, AbFeatures>> {
    const found = new Map<string, AbFeatures>();
    for (let i = 0; i < mbids.length; i += AB_BULK_MAX) {
      const batch = mbids.slice(i, i + AB_BULK_MAX);
      const ids = batch.join(';');
      await paceAb();
      const low = (await getJson(
        `https://acousticbrainz.org/api/v1/low-level?recording_ids=${ids}`,
        'AcousticBrainz',
      )) as AbBulk<AbLowLevel>;
      // High-level is derived from low-level: nothing low, nothing high.
      let high: AbBulk<AbHighLevel> = {};
      if (Object.keys(low).length > 0) {
        await paceAb();
        high = (await getJson(
          `https://acousticbrainz.org/api/v1/high-level?recording_ids=${ids}`,
          'AcousticBrainz',
        )) as AbBulk<AbHighLevel>;
      }
      for (const mbid of batch) {
        const l = low[mbid]?.['0'];
        if (!l) continue;
        const keyKey = l.tonal?.key_key;
        const keyScale = l.tonal?.key_scale;
        found.set(mbid, {
          bpm: l.rhythm?.bpm ?? null,
          musicalKey: keyKey ? (keyScale ? `${keyKey} ${keyScale}` : keyKey) : null,
          danceability: high[mbid]?.['0']?.highlevel?.danceability?.all?.danceable ?? null,
        });
      }
    }
    return found;
  }

  // ── Deezer: artist+title → track id + bpm ───────────────────────────────
  // Public API, no key. Signals errors as 200 + {error} body; bpm 0 means
  // "unknown". The bpm lives on the track detail, not the search hit.

  type DzErrorBody = { error?: { message?: string } };
  type DzSearchResponse = DzErrorBody & { data?: { id: number; duration: number }[] };
  type DzTrackResponse = DzErrorBody & { bpm?: number };

  function dzChecked<T extends DzErrorBody>(data: T): T {
    if (data.error != null) {
      throw new BridgeError('enrichment_error', `Deezer error: ${data.error.message ?? 'unknown'}`);
    }
    return data;
  }

  async function dzFindTrack(
    target: MatchTarget,
  ): Promise<{ trackId: number; bpm: number | null } | null> {
    const query = `artist:"${primaryArtist(target.artist)}" track:"${stripFeat(target.title)}"`;
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`;
    await paceDz();
    const search = dzChecked((await getJson(url, 'Deezer')) as DzSearchResponse);
    const hit = (search.data ?? []).find((h) =>
      durationCompatible(h.duration, target.durationSeconds),
    );
    if (!hit) return null;
    await paceDz();
    const detail = dzChecked(
      (await getJson(`https://api.deezer.com/track/${hit.id}`, 'Deezer')) as DzTrackResponse,
    );
    return { trackId: hit.id, bpm: detail.bpm ? detail.bpm : null };
  }

  return { mbFindRecording, abLookupFeatures, dzFindTrack };
}

export type Sources = ReturnType<typeof createSources>;
