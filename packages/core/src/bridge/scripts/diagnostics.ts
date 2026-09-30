// Read-only Music.app probe for `selecta doctor`. running() checks process
// availability without launching Music; name() is the smallest Apple event
// that proves the Automation boundary is open.

export function buildMusicAppDiagnosticScript(): string {
  return `
const music = Application('Music');
if (!music.running()) throw new Error("Music.app isn't running. (-600)");
const name = music.name();
JSON.stringify({ running: true, automationAuthorized: typeof name === 'string' });
`;
}
