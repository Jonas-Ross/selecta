// Logging shim. stdout is reserved for the MCP protocol channel (and, for CLI
// verbs, the single JSON result) — so all logging goes to stderr. See
// docs/contracts.md §7.
//
// The optional SELECTA_DEBUG=1 file sink at ~/Library/Logs/Selecta/selecta.log
// is deferred to a later milestone; debug() already gates on the env var so the
// call sites are stable.

function format(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

export const log = {
  info: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
  debug: (...a: unknown[]) => {
    if (process.env.SELECTA_DEBUG === '1') process.stderr.write(format(a) + '\n');
  },
  error: (...a: unknown[]) => process.stderr.write(format(a) + '\n'),
};
