// Shared scaffold for every JXA snippet. Interpolates
// args as JSON (valid JS, never via shell quoting), exposes `args` and the
// `Music` application handle to the body, and invokes the run handler so
// osascript prints the body's returned value. Each per-operation builder
// supplies only its body.

export function wrapJxaScript(args: object, body: string): string {
  return `
    const args = ${JSON.stringify(args)};
    function run() {
      const Music = Application('Music');
      ${body}
    }
    run();
  `;
}
