// Turns `claude -p --output-format stream-json` lines into the few events the
// app shows. Unknown line types are ignored so a CLI upgrade can't break a run.
import type { AgentEvent } from '../shared/protocol.js';

type Block = { type?: string; text?: string; name?: string };
type Line = {
  type?: string;
  /** Set on a reply the CLI wrote itself to report a failed request, like `authentication_failed`. */
  error?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: Block[] };
  permission_denials?: { tool_name?: string }[];
};

const shortName = (name = '') => name.replace(/^mcp__selecta__/, '');

/** A run's parser: the CLI says why a request failed in a reply of its own, which the result then repeats. */
export function parseStream(): (raw: string) => AgentEvent[] {
  // The latest failure reply, cleared once the run carries on past it.
  let failure: { type: string; text?: string } | undefined;

  return (raw) => {
    let line: Line;

    try {
      line = JSON.parse(raw) as Line;
    } catch {
      return [];
    }

    if (line.type === 'assistant') {
      if (line.error) {
        failure = { type: line.error, text: line.message?.content?.find((b) => b.text)?.text };

        return [];
      }

      failure = undefined;

      return (line.message?.content ?? []).flatMap((block): AgentEvent[] => {
        if (block.type === 'text' && block.text?.trim())
          return [{ kind: 'text', text: block.text }];

        if (block.type === 'tool_use') return [{ kind: 'tool', name: shortName(block.name) }];

        return [];
      });
    }

    if (line.type === 'result') {
      const denied = (line.permission_denials ?? []).map((denial): AgentEvent => ({
        kind: 'denied',
        name: shortName(denial.tool_name),
      }));
      const end: AgentEvent =
        line.is_error || line.subtype !== 'success'
          ? {
              kind: 'error',
              message:
                line.result || failure?.text || line.subtype || 'Claude stopped with an error.',
              ...(failure?.type === 'authentication_failed' && { signedOut: true }),
            }
          : { kind: 'done', session_id: line.session_id };

      return [...denied, end];
    }

    return [];
  };
}
