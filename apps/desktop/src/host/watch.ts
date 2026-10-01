// The MCP server Claude drives is another process, so its draft edits reach
// the app only through the file. data_version moves whenever another
// connection commits.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

export function watchDrafts(
  path: string,
  onChange: () => void,
  onError: (error: Error) => void,
  intervalMs = 400,
): () => void {
  let db: Database.Database | undefined;
  let last: number | undefined;
  let failing = false;

  const poll = () => {
    // The store is created lazily by the first draft write, which is itself a change.
    if (!db) {
      if (!existsSync(path)) return;

      db = new Database(path, { readonly: true });
      onChange();
    }

    const version = db.pragma('data_version', { simple: true }) as number;

    if (last !== undefined && version !== last) onChange();

    last = version;
  };

  // A throw from the timer would kill the host; reopen on the next tick and report once per outage.
  const timer = setInterval(() => {
    try {
      poll();
      failing = false;
    } catch (error) {
      db?.close();
      db = undefined;
      last = undefined;

      if (!failing) onError(error as Error);

      failing = true;
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    db?.close();
  };
}
