// A local record of what the app did, for debugging a session after the fact:
// one JSON line per action at ~/Library/Logs/Selecta/desktop.log. Reads the
// screens poll are left out unless they fail, or, for the player, change.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Polled or bulk reads: noise when they succeed, so only their failures are kept.
const QUIET = new Set([
  'drafts.get',
  'drafts.list',
  'library.crate',
  'agent.history',
  'artwork.get',
  'player.state',
]);
// One previous file is kept, so a long session costs at most twice this.
const MAX_BYTES = 5 * 1024 * 1024;

export function actionLogPath(home = homedir()): string {
  return join(home, 'Library', 'Logs', 'Selecta', 'desktop.log');
}

export function createActionLog({
  path = actionLogPath(),
  now = () => new Date(),
  maxBytes = MAX_BYTES,
}: { path?: string; now?: () => Date; maxBytes?: number } = {}) {
  const players = new Map<string, string>();
  let broken = false;

  function write(entry: object) {
    if (broken) return;

    try {
      mkdirSync(dirname(path), { recursive: true });

      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      } catch {
        // No file yet.
      }

      appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`);
    } catch (error) {
      // Logging never breaks the app; say so once and stop trying.
      broken = true;
      console.error(`selecta: cannot write ${path}: ${(error as Error).message}`);
    }
  }

  return {
    /** Runs `call`, recording the method, its arguments, how long it took and how it ended. */
    async record<T>(method: string, args: unknown, call: () => Promise<T>): Promise<T> {
      const started = Date.now();

      try {
        const result = await call();

        if (method === 'player.state') {
          const key = (args as { draft_id?: string } | undefined)?.draft_id ?? '';
          const seen = JSON.stringify(result, (field, value) =>
            field === 'position' ? undefined : value,
          );

          if (players.get(key) !== seen) {
            players.set(key, seen);
            write({ method, args, ms: Date.now() - started, result });
          }
        } else if (!QUIET.has(method)) {
          write({
            method,
            args,
            ms: Date.now() - started,
            ...(method.startsWith('player.') && { result }),
          });
        }

        return result;
      } catch (error) {
        write({ method, args, ms: Date.now() - started, error: (error as Error).message });
        throw error;
      }
    },

    /** An event the host raised on its own, such as a Claude run ending. */
    note: (event: string, detail: object) => write({ event, ...detail }),
  };
}
