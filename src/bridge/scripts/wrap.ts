// Shared scaffold for every JXA snippet. Interpolates
// args as JSON (valid JS, never via shell quoting), exposes `args` and the
// `Music` application handle to the body, and calls it so osascript prints
// the returned value (the last top-level expression). Each per-operation
// builder supplies only its body.
//
// ⚠️ The function must NOT be named `run`: osascript treats a defined run()
// as the script's run handler and invokes it implicitly AFTER top-level code,
// so `function run() {...} run();` executes the body TWICE per osascript
// process. That exact bug shipped in v1 and doubled every non-idempotent
// script until the reorder drift guard caught it (docs/music-app.md, JXA).

export function wrapJxaScript(args: object, body: string): string {
  return `
    const args = ${JSON.stringify(args)};
    function selectaMain() {
      const Music = Application('Music');
      ${body}
    }
    selectaMain();
  `;
}
