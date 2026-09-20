# Audio features: two sources, one row

`audio_features` holds what Selecta knows about how a track sounds. Two
independent passes fill it, and `enrich_features` / `node dist/index.js enrich`
pick between them with `source`:

- **`catalog`** — MusicBrainz → AcousticBrainz, then Deezer for bpm the others
  could not supply. Free public services, no keys. Supplies bpm, musical key and
  danceability. AcousticBrainz has been frozen since early 2022, so it has
  nothing for recent releases.
- **`analysis`** — the [metrognome](https://github.com/Jonas-Ross/metrognome)
  binary, run as a subprocess over its `batch` mode, estimating tempo and key
  from each track's 30-second store preview. Supplies bpm and musical key
  (with its Camelot position), and covers what the catalogs cannot.

## Terminal is per source

Every attempt records a terminal `ok` / `no_data` / `no_match`, so a dead end
costs nothing on the next run. That record is **per source**:
`catalog_status` and `analysis_status`, either of which may be `NULL` for
"not attempted yet". Row-level `status` is the better of the two.

A track the catalogs exhausted is therefore still pending analysis — which is
the whole point, since that is exactly the 2022-and-later gap. The two
backlogs are counted separately by `status` and by each pass's
`pending_remaining`.

## Neither pass overwrites the other

`mergeFeatures` (`src/cache/audio_features.ts`) gap-fills: a feature already on
the row keeps its value, confidence and provenance, and each pass writes only
its own terminal status. The catalogs describe the whole recording where
analysis hears a 30-second preview; neither has been measured against the
other, so overwriting on that basis would be a guess dressed as an improvement.
Per-field confidence and maturity are stored precisely so a future supersede
rule has something to decide on.

## What the summary counts mean

Each run reports `returned` (tracks the source stood behind an estimate for)
and `enriched` (tracks where a value actually landed in storage this run).
They diverge exactly where gap-fill applies: a source can return `ok` for a
track that already has that feature from the other source, and `mergeFeatures`
discards the estimate rather than overwriting it. `returned` is the source's
own hit rate; `enriched` is what the run actually changed.

## Camelot is derived, not sourced

Camelot notation is the key written on a clock face — the number is a position
on the circle of fifths, the letter the mode — so keys that sit next to each
other mix cleanly. It carries no information the key does not, which is why
`camelot` is derived from whatever `musical_key` a row ends up with
(`src/domain/camelot.ts`) rather than stored only when the source that reported
the key happened to include one. A catalog key earns its position exactly as an
analyzed one does; a key string with no mode (AcousticBrainz can supply a bare
tonic) has no position and keeps whatever it had. Migration 4 backfills the
column for keys already stored.

## Harmonic relations are geometry, not a score

`inspect_tracklist` reports a `harmonic` block: one entry per adjacent pair in
the draft, naming how the two wheel positions relate (`src/domain/harmonic.ts`).

- `same` — identical position.
- `adjacent` — one step either way, which is a fifth apart.
- `relative` — the A/B pair on one number, relative minor and major.
- `energy_boost` — two steps up. Directional: two steps *down* is `distant`.
- `distant` — anything else.
- `unknown` — at least one side has no position.

The Camelot convention treats the first four as clean mixes and `distant` as a
clash. Selecta does not say so in the payload, and emits no score, ranking or
verdict over the draft: reading a relation as good or bad is sequencing, which
is the model's job under the no-taste rule. What Selecta owes is the geometry
and the caveats on it — hence `provisional: true` on a transition resting on a
provisional key estimate, and `provisional_key_positions` beside it.

Transitions are keyed by `from_position`, the 0-based index into `tracks`, the
same identity `duplicate_ids.positions` uses: a repeated track is a different
transition each time it appears, and IDs could not say which. They carry no
Camelot strings and no prose label, because both are already derivable from
`tracks` and repeating them costs a third of the payload on a 500-track draft.
The plain-language reading of each relation lives in the tool description,
which is the model's interface to this.

`unknown_key_positions` is not the same set as the `musical_key` feature gap.
AcousticBrainz can supply a bare tonic ("F"), which is a key Selecta has but
not a position on the wheel — covered by one measure, absent from the other. A
key Selecta does not have is never inferred from its neighbours.

## What the model actually reads

`camelot` rides every projection `musical_key` rides: `search`,
`get_track_context`, `inspect_tracklist`, the explorer page and the draft card,
full and compact alike. In compact output it is a slot of its own, directly
after `musical_key` in `track_fields` — positional readers index off that array,
never off a remembered offset. The draft timeline's key lane leads with the
position and keeps the key beside it ("11A F# minor"), because the position is
what a DJ reads and the key is what everything else calls it.

Confidence and maturity do not ride along. They are per feature, so honest bulk
surfacing means four more values on every row of a hundred-track discovery
result, qualifying a fact that does not change which tracks are candidates.
`inspect_tracklist` carries them instead (`bpm_confidence`, `bpm_maturity`,
`key_confidence`, `key_maturity`, omitted where nothing was recorded): that call
is the deliberate look at a tracklist someone has already settled on, which is
exactly where "this key is provisional" should change what gets built on it.
Scanning is cheap there and expensive everywhere else.

## An uncertain estimate is not stored

metrognome flags an estimate `uncertain` when a preview is a beatless intro or
a breakdown. Selecta drops those rather than storing them: absent means
"nothing worth trusting", not "not attempted", and the terminal status still
records the attempt. It also carries each estimate's own confidence (0-1) and
`maturity`, which is the estimator's own account of itself — metrognome's tempo
is `validated` against published references, its key `provisional`, so a key
from analysis is a hint however confident the number looks.

## Watching a long run

A whole-library `analysis` backlog is thousands of tracks at ~1-3s each, which
is hours. `stdout` stays the JSON channel — one summary object when the run
ends — so everything a human reads is on `stderr`, and what `stderr` gets
depends on whether it is a terminal:

- **A terminal** gets one live line, redrawn in place: tracks done out of the
  budget, percentage, enriched so far, any skipped, throughput, ETA, and the
  track being worked on. It repaints on a timer as well as on progress, so the
  elapsed picture keeps moving through a slow track rather than looking hung.
  Counters settle a chunk at a time and the track name moves between chunks.
- **Anything else** (`2> run.log`, a pipe, CI) gets the same content as plain
  lines with no control characters, at most one per 15 seconds plus the last
  one, so the file stays readable and greppable.

The fork was between one live line and a scrolling narration. Per-request
narration (every MusicBrainz query, every metrognome log line) would scroll the
live line away within a second, so it moved to debug level: run with
`SELECTA_DEBUG=1` to put it back on `stderr` and into
`~/Library/Logs/Selecta/selecta.log`. Redirecting `stderr` to keep a log is
therefore no longer the only way to see a run — and it is the one way to see
nothing while it runs.

## Superseding what an older algorithm measured

An estimator that improves leaves worse values behind it, and nothing in the
normal path reaches them: gap-fill keeps whatever is already on the field, and
the source's attempt is terminal, so a later run never revisits the track. Both
have to be undone together.

`node dist/index.js supersede` does that, in two steps so neither is a guess:

- With no `--provenance`, it lists every algorithm string currently stored,
  per field, with a track count. Nothing changes. This is also how a caller
  learns the exact strings the flag takes — Selecta does not know metrognome's
  versioning and must not hardcode it.
- With `--provenance <value...>`, it clears exactly the values recorded under
  those strings, along with the confidence, maturity and Camelot that described
  them, and clears `--source`'s terminal status so the backlog includes those
  tracks again. A row left with no values and no attempt on either source is
  removed rather than kept claiming a row-level status nothing supports.

Anything the other source supplied is untouched, as is anything a newer version
of the same algorithm wrote. It runs under the enrichment lock, so it cannot
interleave with a run in progress.

Naming a provenance the given `--source` did not produce is refused rather than
applied: only that source's attempt reopens, so clearing the other's values
would strand them — its status stays terminal, nothing refetches, and with the
provenance gone a second `supersede` could no longer find the row to repair it.
The catalog pass writes a closed set of provenance strings (`acousticbrainz`,
`deezer`), so anything else is analysis; that is how a value is attributed
without Selecta knowing metrognome's versions.

Superseding is a judgement that the newer algorithm is better, which is not the
same as newer. metrognome's own `validate` against real recordings is what
settles that; a version bump alone is not evidence.

## Configuration

The binary is found at `SELECTA_METROGNOME_PATH`, the CLI's
`--metrognome-path`, or `metrognome` on `PATH`. When it is missing the run
returns every track skipped with the reason in `source_errors` and changes
nothing — Selecta is in daily use and an absent optional binary is not an
outage.
