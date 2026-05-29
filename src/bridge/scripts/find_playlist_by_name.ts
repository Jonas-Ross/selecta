// JXA snippet: resolve a playlist's persistent ID by name. Test-support for the
// opt-in integration test (targets a hand-set-up "Selecta Test" playlist without
// hardcoding an ID). Emits the persistent ID string, or null if no match.
// Args interpolated as JSON — see docs/contracts.md §4.

export function buildFindPlaylistByNameScript(args: { name: string }): string {
  return `
    const args = ${JSON.stringify(args)};
    function run() {
      const Music = Application('Music');
      const matches = Music.playlists.whose({ name: args.name });
      if (matches.length === 0) return JSON.stringify(null);
      return JSON.stringify(matches[0].persistentID());
    }
    run();
  `;
}
