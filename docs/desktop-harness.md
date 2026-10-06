# Desktop test harness

The desktop app runs end to end without a Mac: the real Electron build, the real host, core and MCP server, against a simulated Music.app and a scripted Claude. It is how the app gets tested without a person at the keyboard, and how a change to Listen gets checked before it reaches the real Music.app.

## How it fits together

Selecta never touches audio: Music.app plays, and the app only reads and moves Music's player through JXA scripts (`docs/desktop-app.md`, Listen). So the hard part of testing Listen is not sound, it is Music's player: where it is, what it does next, and how it answers late or not at all. The harness replaces exactly the three programs the app shells out to, through `PATH`, and nothing in `src` knows:

| Program | Replaced by | Does |
|---|---|---|
| `osascript` | `harness/bin/osascript` | Sends the JXA script to `MusicSim`, which runs it in a VM against a model of Music's scripting objects |
| `claude` | `harness/bin/claude` (via `SELECTA_CLAUDE_PATH`) | Runs the test's turn script, which calls the real MCP server the app configured, under the app's own allow and deny lists |
| `sips` | `harness/bin/sips` | Copies the sleeve, which is already thumbnail-sized |

The shims post to a small HTTP server inside the Playwright process (`harness/server.ts`), so a test holds the simulator and the Claude script directly. Each test gets a throwaway `HOME`, with the cache seeded through the real `read_library` script, so the app's database, drafts, artwork and action log all land there.

### The simulated Music.app

`harness/music.ts` runs the bridge's own scripts, unchanged, which is the point: the 300-line play script and its retry loops are what break on a real Mac, so they are what get tested. `delay()` advances simulated time instead of sleeping, so a script that polls for five seconds finishes in microseconds. It models what `docs/music-app.md` records:

- commands land about 150 ms late, so every step must read back;
- playing a playlist gives Music a queue it carries on through, stopping after the last record;
- `previousTrack` restarts a record more than 3 s in rather than stepping back;
- AutoMix, Music's automatic blend between records, hands over 4.5 s before the end with the next record already 7 s in (off unless a test turns it on);
- shuffle, an open Settings window swallowing play, iCloud doubling an add or rotating a playlist's ID, a second playlist named Selecta Preview, and the user picking another record in Music.

Time runs at real speed so the screen moves; `advance(seconds)` skips ahead, and `setSpeed(0)` freezes it for exact positions.

## Running it

```bash
npm run e2e                        # build, then the Playwright specs on a Mac
xvfb-run -a npm run e2e            # the same on Linux, which needs a display
npx vitest run apps/desktop/test/music_sim.test.ts   # the bridge scripts against the simulator; part of npm test
```

A failure keeps a Playwright trace and screenshot in `apps/desktop/test-results/`. `npx playwright show-trace <trace.zip>` replays it step by step. Linux runs as root need Chromium's sandbox off, which the fixture does.

## Two tiers, and what only the Mac can say

1. **Bridge scripts against the simulator** (`test/music_sim.test.ts`, in `npm test`). Milliseconds, no Electron. Where a playback race or refusal is pinned.
2. **The app against the simulator** (`e2e/*.spec.ts`, `npm run e2e`). Seconds per test. Where a screen's behaviour is pinned: the rail follows Music, a reorder reaches the preview, a refusal is shown.

The simulator is only as right as what it was told. What Music actually does still comes from the real one, through `npm run test:integration` and Remote Control on the Mac: whether AutoMix's timing holds, how late commands really land under load, what iCloud does to a fresh playlist. When the Mac shows Music doing something the simulator doesn't, the fix is a change to `MusicSim` and a test that reproduces it, alongside the `docs/music-app.md` note.

Out of the simulator's reach: the audio itself, Music.app's own UI, the macOS Automation prompt, and real `claude` output, which `test/fixtures/build-draft.jsonl` covers as a recording.
