// Pure view logic, kept out of the components so it tests without a DOM.
import type { Draft } from '@selecta/core/drafts/contracts.js';
import type { AgentEvent } from '../shared/protocol.js';

export type Track = {
  title?: string;
  artist?: string;
  duration_seconds?: number;
  bpm?: number;
  camelot?: string;
};
export type DraftView = {
  draft?: Draft;
  preview?: { owner?: string; status: string };
  inspection?: { tracks: Track[] };
  error?: string;
  hint?: string;
};
export type Row = Draft['entries'][number] & Track;
export type LogItem = { kind: 'you' | 'claude' | 'tool' | 'error'; text: string };

/** Inspection tracks line up one to one with entries, repeats included. */
export function rows(view: DraftView): Row[] {
  const tracks = view.inspection?.tracks ?? [];

  return (view.draft?.entries ?? []).map((entry, index) => ({ ...tracks[index], ...entry }));
}

/** Core mirrors ordered edits of a linked draft into Music.app's preview playlist. */
export function previewLinked(view: DraftView): boolean {
  return (
    view.preview?.owner !== undefined &&
    view.preview.owner === view.draft?.draft_id &&
    view.preview.status !== 'inactive'
  );
}

export function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);

  next.splice(to, 0, item);

  return next;
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined) return '';

  const whole = Math.round(seconds);

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function totalDuration(items: Row[]): string {
  const known = items.flatMap((row) => row.duration_seconds ?? []);
  const minutes = Math.round(known.reduce((sum, value) => sum + value, 0) / 60);

  return `${items.length} tracks · ${minutes} min${known.length < items.length ? '+' : ''}`;
}

/** Selection travels as text: it names the subject of the feedback, nothing more. */
export function feedbackMessage(text: string, selected: Row[]): string {
  if (!selected.length) return text;

  const about = selected
    .map(
      (row) =>
        `- ${row.title ?? row.track_id} by ${row.artist ?? 'unknown'} (entry ${row.entry_id})`,
    )
    .join('\n');

  return `About these tracks:\n${about}\n\n${text}`;
}

export function logAgentEvent(log: LogItem[], event: AgentEvent): LogItem[] {
  switch (event.kind) {
    case 'text':
      return [...log, { kind: 'claude', text: event.text }];
    case 'tool':
      return [...log, { kind: 'tool', text: event.name.replaceAll('_', ' ') }];
    case 'denied':
      return [...log, { kind: 'error', text: `Blocked ${event.name}: the app saves, not Claude.` }];
    case 'error':
      return [...log, { kind: 'error', text: event.message }];
    case 'done':
      return log;
  }
}

/** A draft's conversation, held above the screens so leaving one never drops how a run ended. */
export type Run = { log: LogItem[]; working: boolean };

export function askRun(run: Run | undefined, text: string): Run {
  return { log: [...(run?.log ?? []), { kind: 'you', text }], working: true };
}

// Any event but the last one means a run is live, even one this renderer didn't start.
export function runEvent(run: Run | undefined, event: AgentEvent): Run {
  return {
    log: logAgentEvent(run?.log ?? [], event),
    working: event.kind !== 'done' && event.kind !== 'error',
  };
}

/** Runs the host still has going after a reload; one that already reported keeps its own state. */
export function recoverActive(runs: Record<string, Run>, active: string[]): Record<string, Run> {
  return {
    ...Object.fromEntries(active.map((id) => [id, { log: [], working: true }])),
    ...runs,
  };
}

/** Runs with no stored draft yet: a build still starting, or one that failed before creating it. */
export function orphanRuns(runs: Record<string, Run>, drafts: { draft_id: string }[]) {
  const stored = new Set(drafts.map((draft) => draft.draft_id));

  return Object.entries(runs)
    .filter(([draftId]) => !stored.has(draftId))
    .map(([draft_id, run]) => ({
      draft_id,
      brief: run.log.find((item) => item.kind === 'you')?.text ?? '',
      working: run.working,
    }))
    .reverse();
}

/** A plain sentence for whatever the save call returned. */
export function saveOutcome(response: DraftView & { result?: Record<string, unknown> }): string {
  if (response.error) return [response.error, response.hint].filter(Boolean).join(' ');

  const result = response.result ?? {};
  const saved = `Saved "${String(result.name)}" to Music with ${String(result.track_count)} tracks.`;

  return result.order_matches_request === false
    ? `${saved} Music.app reports a different order than the draft; check the playlist.`
    : saved;
}

type Save = NonNullable<NonNullable<DraftView['draft']>['save']>;

/** A recorded attempt, good or bad, blocks another: core never repeats a write. */
export function saveLabel(save?: Save): string {
  if (!save) return 'Save to Music';

  if (save.status === 'pending') return 'Save pending';

  return save.result?.error ? 'Save uncertain' : 'Saved';
}
