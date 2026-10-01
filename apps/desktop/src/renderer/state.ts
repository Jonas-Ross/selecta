// Pure view logic, kept out of the components so it tests without a DOM.
import type { Draft } from '@selecta/core/drafts/contracts.js';
import type { AgentEvent, RunSnapshot } from '../shared/protocol.js';

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
    case 'asked':
      return [...log, { kind: 'you', text: event.text }];
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

/** A draft's conversation as the host numbered it; `seen` is how many host events it holds. */
export type Run = { log: LogItem[]; working: boolean; seen: number };

/** Host event `seq` applied in order; undefined means one was missed, so resync from the host. */
export function runEvent(run: Run | undefined, event: AgentEvent, seq: number): Run | undefined {
  const seen = run?.seen ?? 0;

  if (seq < seen) return run;

  if (seq > seen) return;

  return {
    log: logAgentEvent(run?.log ?? [], event),
    working: event.kind !== 'done' && event.kind !== 'error',
    seen: seen + 1,
  };
}

/** The host's record wins wherever it holds more than this renderer has seen. */
export function recoverRuns(
  runs: Record<string, Run>,
  history: Record<string, RunSnapshot>,
): Record<string, Run> {
  const next = { ...runs };

  for (const [id, { events, working }] of Object.entries(history))
    if (events.length > (runs[id]?.seen ?? 0))
      next[id] = { log: events.reduce(logAgentEvent, []), working, seen: events.length };

  return next;
}

/** A call the host rejected outright: nothing started, so nothing changes but the log. */
/** The host refuses before recording the request, so the request is kept here with its error. */
export function rejectRun(run: Run | undefined, message: string, asked?: string): Run {
  return {
    log: [
      ...(run?.log ?? []),
      ...(asked ? [{ kind: 'you' as const, text: asked }] : []),
      { kind: 'error', text: message },
    ],
    working: run?.working ?? false,
    seen: run?.seen ?? 0,
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
export function saveOutcome(
  response: DraftView & {
    result?: Record<string, unknown>;
    partial_write?: { playlist_id?: unknown; observed_track_ids?: unknown };
  },
): string {
  const { result, partial_write: partial } = response;
  const parts: string[] = [];

  // An error can still carry what Music.app was seen to do; this app has no other view of it.
  if (result?.name !== undefined) {
    parts.push(
      `Saved "${String(result.name)}" to Music with ${String(result.track_count)} tracks.`,
    );

    if (result.order_matches_request === false)
      parts.push('Music.app reports a different order than the draft; check the playlist.');
  } else if (partial?.playlist_id !== undefined) {
    const seen = Array.isArray(partial.observed_track_ids)
      ? ` and was seen holding ${partial.observed_track_ids.length} tracks`
      : '';

    parts.push(`Music.app created playlist ${String(partial.playlist_id)}${seen}.`);
  }

  if (response.error) parts.push(response.error, ...(response.hint ? [response.hint] : []));

  return parts.join(' ');
}

type Save = NonNullable<NonNullable<DraftView['draft']>['save']>;

/** A recorded attempt, good or bad, blocks another: core never repeats a write. */
export function saveLabel(save?: Save): string {
  if (!save) return 'Save to Music';

  if (save.status === 'pending') return 'Save pending';

  // A cleanup failure after a committed creation still means the playlist exists.
  return save.result?.error && save.result.creation_committed !== true ? 'Save uncertain' : 'Saved';
}
