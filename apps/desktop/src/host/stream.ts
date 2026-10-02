// Turns `claude -p --output-format stream-json` lines into the few events the
// app shows. Unknown line types are ignored so a CLI upgrade can't break a run.
import type { AgentEvent } from '../shared/protocol.js';

type Block = { type?: string; text?: string; name?: string };
type Line = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: Block[] };
  permission_denials?: { tool_name?: string }[];
};

const shortName = (name = '') => name.replace(/^mcp__selecta__/, '');

export function parseStreamLine(raw: string): AgentEvent[] {
  let line: Line;

  try {
    line = JSON.parse(raw) as Line;
  } catch {
    return [];
  }

  if (line.type === 'assistant')
    return (line.message?.content ?? []).flatMap((block): AgentEvent[] => {
      if (block.type === 'text' && block.text?.trim()) return [{ kind: 'text', text: block.text }];

      if (block.type === 'tool_use') return [{ kind: 'tool', name: shortName(block.name) }];

      return [];
    });

  if (line.type === 'result') {
    const denied = (line.permission_denials ?? []).map((denial): AgentEvent => ({
      kind: 'denied',
      name: shortName(denial.tool_name),
    }));
    const end: AgentEvent =
      line.is_error || line.subtype !== 'success'
        ? { kind: 'error', message: line.result || line.subtype || 'Claude stopped with an error.' }
        : { kind: 'done', session_id: line.session_id };

    return [...denied, end];
  }

  return [];
}
