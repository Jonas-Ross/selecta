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

## An uncertain estimate is not stored

metrognome flags an estimate `uncertain` when a preview is a beatless intro or
a breakdown. Selecta drops those rather than storing them: absent means
"nothing worth trusting", not "not attempted", and the terminal status still
records the attempt. It also carries each estimate's own confidence (0-1) and
`maturity`, which is the estimator's own account of itself — metrognome's tempo
is `validated` against published references, its key `provisional`, so a key
from analysis is a hint however confident the number looks.

## Configuration

The binary is found at `SELECTA_METROGNOME_PATH`, the CLI's
`--metrognome-path`, or `metrognome` on `PATH`. When it is missing the run
returns every track skipped with the reason in `source_errors` and changes
nothing — Selecta is in daily use and an absent optional binary is not an
outage.
