// Turns `codex exec --json` lines into the app's events. The thread ID arrives
// on the first line and the turn's end on the last, so a parser lives for one run.
import type { AgentEvent } from '../shared/protocol.js';

type Item = { type?: string; text?: string; tool?: string };
type Line = {
  type?: string;
  message?: string;
  thread_id?: string;
  item?: Item;
  error?: { message?: string };
};

export function parseCodexLine(): (raw: string) => AgentEvent[] {
  let thread: string | undefined;
  let notice: string | undefined;

  return (raw) => {
    let line: Line;

    try {
      line = JSON.parse(raw) as Line;
    } catch {
      return [];
    }

    switch (line.type) {
      case 'thread.started':
        thread = line.thread_id;

        return [];
      case 'item.started':
        return line.item?.type === 'mcp_tool_call'
          ? [{ kind: 'tool', name: line.item.tool ?? '' }]
          : [];
      case 'item.completed':
        return line.item?.type === 'agent_message' && line.item.text?.trim()
          ? [{ kind: 'text', text: line.item.text }]
          : [];
      case 'turn.completed':
        return [{ kind: 'done', session_id: thread }];
      case 'turn.failed':
        return [{ kind: 'error', message: line.error?.message || 'Codex stopped with an error.' }];
      // Codex keeps retrying after these ("Reconnecting...", even indefinitely while offline),
      // so the run stays open; shown once each so a stalled run says why.
      case 'error':
        if (!line.message || line.message === notice) return [];

        notice = line.message;

        return [{ kind: 'text', text: line.message }];
      default:
        return [];
    }
  };
}
