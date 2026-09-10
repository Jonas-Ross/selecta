#!/usr/bin/env node
// Retained as a command entry point so old automation fails with a useful
// explanation instead of running the retired create/poll/delete probe.

console.error(
  'verify:echo is retired: refresh reports ambiguous copies and never deletes playlists.\n' +
    'Run npm test for fixture coverage of reconciliation, notes, and receipts.\n' +
    'For manual inspection, run refresh and inspect sync_reconciliation.ambiguous; ' +
    'choose a copy explicitly before using delete_playlist. See docs/music-app.md.\n' +
    'No live verification was performed.',
);
process.exitCode = 1;
