// Pure view logic, kept out of the components so it tests without a DOM.
import type { Draft } from '@selecta/core/drafts/contracts.js';
import type { AgentEvent, ProviderId, RunSnapshot } from '../shared/protocol.js';

type Maturity = 'validated' | 'provisional';

/** An inspection track: features carry where they came from and how sure that was. */
export type Track = {
  title?: string;
  artist?: string;
  duration_seconds?: number;
  bpm?: number;
  bpm_confidence?: number;
  bpm_maturity?: Maturity;
  bpm_source?: string;
  bpm_half_time?: number;
  musical_key?: string;
  camelot?: string;
  key_confidence?: number;
  key_maturity?: Maturity;
  key_source?: string;
};
export type DraftView = {
  draft?: Draft;
  preview?: { owner?: string; status: string };
  inspection?: { tracks: Track[] };
  error?: string;
  hint?: string;
};
export type Row = Draft['entries'][number] & Track;
// `brief` marks the request that started a draft, as opposed to feedback on one.
export type LogItem = { kind: 'you' | 'claude' | 'tool' | 'error'; text: string; brief?: true };

/** Inspection tracks line up one to one with entries, repeats included. */
export function rows(view: DraftView): Row[] {
  const tracks = view.inspection?.tracks ?? [];

  return (view.draft?.entries ?? []).map((entry, index) => ({ ...tracks[index], ...entry }));
}

/** An order the user just made, and every entry that was on the rail when they made it. */
export type Pending = { order: string[]; known: string[] };

/** A new pending order that still knows what earlier unsettled edits saw, so their removals stay out. */
export function nextPending(prev: Pending | undefined, order: string[], ids: string[]): Pending {
  return { order, known: [...new Set([...(prev?.known ?? []), ...ids])] };
}

/**
 * The order the user just made, ahead of the stored one until its edit
 * settles. Entries the store has since dropped vanish, ones the user left out
 * stay out, and ones the store has since added (Claude, mid-drag) keep their
 * stored place after the pending ones.
 */
export function pendingOrder(items: Row[], pending?: Pending): Row[] {
  if (!pending) return items;

  const byId = new Map(items.map((row) => [row.entry_id, row]));
  const placed = new Set(pending.known);
  const shown = [
    ...pending.order.flatMap((id) => byId.get(id) ?? []),
    ...items.filter((row) => !placed.has(row.entry_id)),
  ];

  // Stale ids never leave an empty rail; the stored order shows until the edit settles.
  return shown.length ? shown : items;
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

/** Known minutes, and whether some lengths are missing so the real total is longer. */
export function totals(items: Row[]) {
  const known = items.flatMap((row) => row.duration_seconds ?? []);

  return {
    tracks: items.length,
    minutes: Math.round(known.reduce((sum, value) => sum + value, 0) / 60),
    partial: known.length < items.length,
  };
}

/** Slowest and fastest measured tempo, whole BPM; undefined when none is measured. */
export function bpmSpan(items: Row[]): [number, number] | undefined {
  const known = items.flatMap((row) => (row.bpm === undefined ? [] : Math.round(row.bpm)));

  return known.length ? [Math.min(...known), Math.max(...known)] : undefined;
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
      return [...log, { kind: 'you', text: event.text, ...(event.brief && { brief: true }) }];
    case 'text':
      return [...log, { kind: 'claude', text: event.text }];
    case 'tool':
      return [...log, { kind: 'tool', text: event.name.replaceAll('_', ' ') }];
    case 'denied':
      return [...log, { kind: 'error', text: `Blocked ${event.name}: only the app saves.` }];
    case 'error':
      return [...log, { kind: 'error', text: event.message }];
    case 'done':
      return log;
  }
}

/** A draft's conversation as the host numbered it; `seen` is how many host events it holds. */
export type Run = { log: LogItem[]; working: boolean; seen: number; by?: ProviderId };

/** Who answered the latest request, for the panel's name. */
const askedBy = (by: ProviderId | undefined, event: AgentEvent) =>
  event.kind === 'asked' && event.by ? event.by : by;

/** Host event `seq` applied in order; undefined means one was missed, so resync from the host. */
export function runEvent(run: Run | undefined, event: AgentEvent, seq: number): Run | undefined {
  const seen = run?.seen ?? 0;

  if (seq < seen) return run;

  if (seq > seen) return;

  return {
    log: logAgentEvent(run?.log ?? [], event),
    working: event.kind !== 'done' && event.kind !== 'error',
    seen: seen + 1,
    by: askedBy(run?.by, event),
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
      next[id] = {
        log: events.reduce(logAgentEvent, []),
        working,
        seen: events.length,
        by: events.reduce(askedBy, undefined),
      };

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
    by: run?.by,
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
