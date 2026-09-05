import type { z } from 'zod';
import * as schemas from './schemas.js';
import { parsePayload } from '../types/validation.js';
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
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export function withUserAgent(fetchImpl: typeof fetch): FetchLike {
  return (url) =>
    fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
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
  cooldown?: { get(host: string): number | null; set(host: string, until: number): void };
  // Moment-to-moment narration ("MusicBrainz "Red Lights" — Tiësto …", then
  // the outcome). The CLI wires this to stderr; the MCP tool leaves it unset.
  trace?: (line: string) => void;
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
  const trace = deps.trace ?? (() => {});
  const localCooldowns = new Map<string, number>();
  const cooldown = deps.cooldown ?? {
    get: (host: string) => localCooldowns.get(host) ?? null,
    set: (host: string, until: number) => {
      localCooldowns.set(host, until);
    },
  };

  async function getJson<T>(url: string, source: string, schema: z.ZodType<T>): Promise<T> {
    const host = new URL(url).host;
    const cooldownUntil = cooldown.get(host);
    if (cooldownUntil != null && cooldownUntil > deps.nowMs()) {
      throw new BridgeError(
        'enrichment_error',
        `${source} is cooling down until ${new Date(cooldownUntil).toISOString()}; request skipped`,
      );
    }
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
      const header = res.headers?.get('Retry-After');
      if ((res.status === 429 || res.status === 503) && header) {
        const until = /^\d+$/.test(header.trim())
          ? deps.nowMs() + Number(header) * 1000
          : Date.parse(header);
        if (until > deps.nowMs()) {
          // Keep even excessive delays without holding an operation open for hours.
          const deadline = Math.min(until, 8.64e15);
          cooldown.set(host, deadline);
          const remaining = deadline - deps.nowMs();
          if (remaining <= 60_000) {
            trace(`${source} requested a ${Math.ceil(remaining / 1000)}s cooldown; no retry`);
            await deps.sleep(remaining);
          } else {
            trace(
              `${source} paused until ${new Date(deadline).toISOString()}; remaining requests to this host will be skipped`,
            );
          }
        }
      }
      throw new BridgeError('enrichment_error', `${source} responded ${res.status} for ${url}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BridgeError('enrichment_error', `${source} returned unparseable JSON for ${url}`);
    }
    return parsePayload(schema, body, source, 'enrichment_error');
  }

  // ── MusicBrainz: artist+title → recording MBID ──────────────────────────

  // Search scores run 0–100; below this the top hit is usually a different
  // song. Results are score-ordered, so the scan stops at the first sub-gate.
  const MB_MIN_SCORE = 85;

  async function mbFindRecording(target: MatchTarget): Promise<string | null> {
    const query = `recording:"${luceneEscape(stripFeat(target.title))}" AND artist:"${luceneEscape(primaryArtist(target.artist))}"`;
    const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
    await paceMb();
    trace(`MusicBrainz "${target.title}" — ${target.artist} …`);
    const data = await getJson(url, 'MusicBrainz', schemas.mbSearch);
    for (const rec of data.recordings) {
      if (rec.score < MB_MIN_SCORE) break;
      if (
        durationCompatible(rec.length != null ? rec.length / 1000 : null, target.durationSeconds)
      ) {
        trace(`  ↳ recording ${rec.id.slice(0, 8)} (score ${rec.score})`);
        return rec.id;
      }
    }
    trace('  ↳ no confident match');
    return null;
  }

  // ── AcousticBrainz: MBIDs → bpm / key / danceability ────────────────────
  // Archive frozen since early 2022 — an MBID absent from the response is the
  // normal "no data" case for recent releases, not a failure. Only the BULK
  // endpoints are usable: measured live, per-MBID GETs take ~60s while a bulk
  // lookup answers in a few seconds regardless of ID count, so features are
  // fetched per 25-MBID chunk (the endpoint's max).

  const AB_BULK_MAX = 25;

  async function abLookupFeatures(mbids: string[]): Promise<Map<string, AbFeatures>> {
    const found = new Map<string, AbFeatures>();
    for (let i = 0; i < mbids.length; i += AB_BULK_MAX) {
      const batch = mbids.slice(i, i + AB_BULK_MAX);
      const ids = encodeURIComponent(batch.join(';'));
      await paceAb();
      trace(`AcousticBrainz bulk low-level: ${batch.length} recordings …`);
      const low = await getJson(
        `https://acousticbrainz.org/api/v1/low-level?recording_ids=${ids}`,
        'AcousticBrainz',
        schemas.abLow,
      );
      trace(`  ↳ data for ${Object.keys(low).length}/${batch.length}`);
      // High-level is derived from low-level: nothing low, nothing high.
      let high: z.infer<typeof schemas.abHigh> = {};
      if (Object.keys(low).length > 0) {
        await paceAb();
        trace(`AcousticBrainz bulk high-level: ${batch.length} recordings …`);
        high = await getJson(
          `https://acousticbrainz.org/api/v1/high-level?recording_ids=${ids}`,
          'AcousticBrainz',
          schemas.abHigh,
        );
        trace(`  ↳ data for ${Object.keys(high).length}/${batch.length}`);
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

  function dzChecked<T>(data: T | { error: { message?: string } }): T {
    if (typeof data === 'object' && data !== null && 'error' in data) {
      throw new BridgeError('enrichment_error', `Deezer error: ${data.error.message ?? 'unknown'}`);
    }
    return data as T;
  }

  // Deezer documents no escape for quotes inside artist:"…"/track:"…" — an
  // embedded " would end the field early and fabricate a terminal no_match.
  // Strip them; the duration gate still guards the match.
  const dzField = (s: string): string => s.replace(/"/g, '');

  async function dzFindTrack(
    target: MatchTarget,
  ): Promise<{ trackId: number; bpm: number | null } | null> {
    const query = `artist:"${dzField(primaryArtist(target.artist))}" track:"${dzField(stripFeat(target.title))}"`;
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`;
    await paceDz();
    trace(`Deezer "${target.title}" — ${target.artist} …`);
    const search = dzChecked(await getJson(url, 'Deezer', schemas.dzSearch));
    const hit = search.data.find((h) => durationCompatible(h.duration, target.durationSeconds));
    if (!hit) {
      trace('  ↳ no match');
      return null;
    }
    await paceDz();
    const detail = dzChecked(
      await getJson(`https://api.deezer.com/track/${hit.id}`, 'Deezer', schemas.dzTrack),
    );
    trace(detail.bpm ? `  ↳ bpm ${detail.bpm}` : '  ↳ matched, bpm unknown');
    return { trackId: hit.id, bpm: detail.bpm ? detail.bpm : null };
  }

  return { mbFindRecording, abLookupFeatures, dzFindTrack };
}

export type Sources = ReturnType<typeof createSources>;
