import { z } from 'zod';
import { Draft, DraftResponse, DraftSaveOutcome, type DraftView } from '../src/drafts/contracts.js';

const record = z.record(z.string(), z.unknown());
const envelope = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decode once, keeping receipt data even when a failed save cannot become view state. */
export function decodeDraftResult(result: unknown) {
  const parsed = envelope.safeParse(result);

  if (!parsed.success) return { receipt: {}, error: 'Invalid tool response.' };

  const outer = parsed.data;
  let raw = outer.structuredContent;

  if (raw === undefined) {
    const text = outer.content?.find((item) => item.type === 'text')?.text ?? '';

    try {
      raw = JSON.parse(text);
    } catch {
      return { receipt: {}, error: text || 'Tool returned no readable response.' };
    }
  }

  const payload = record.safeParse(raw);

  if (!payload.success) return { receipt: {}, error: 'Invalid tool response.' };

  const receipt = payload.data;
  const response = DraftResponse.safeParse(receipt);
  const hint = typeof receipt.hint === 'string' ? receipt.hint : undefined;
  const failed = outer.isError || typeof receipt.error === 'string';

  if (!response.success)
    return {
      receipt,
      error: [hint, 'Invalid draft response. Use Reload latest to inspect current state.']
        .filter(Boolean)
        .join(' '),
    };

  return {
    receipt,
    data: response.data,
    error: failed ? (hint ?? 'Tool failed. Reload the latest draft before continuing.') : undefined,
  };
}

/** A save receipt has no inspection. Reuse facts only for the same ordered tracks. */
export function acceptDraftResponse(
  previous: DraftView | undefined,
  data: DraftResponse,
  typed: string,
) {
  const draft = data.draft;

  if (!draft) throw new Error('Original draft data is unavailable. Recover using the draft ID.');

  const same = previous?.draft.draft_id === draft.draft_id;

  if (same && draft.revision < previous.draft.revision)
    return { state: previous, feedback: typed, accepted: false };

  const ids = new Set(draft.entries.map((entry) => entry.entry_id));

  if (
    ids.size !== draft.entries.length ||
    new Set(draft.selected_entry_ids).size !== draft.selected_entry_ids.length ||
    draft.selected_entry_ids.some((id) => !ids.has(id))
  )
    throw new Error('Invalid draft occurrence IDs. Use Reload latest.');

  const sameTracks =
    same &&
    JSON.stringify(previous.draft.entries.map((entry) => entry.track_id)) ===
      JSON.stringify(draft.entries.map((entry) => entry.track_id));
  const inspection =
    data.inspection ?? (sameTracks && !data.inspection_error ? previous.inspection : undefined);
  const inspection_error =
    data.inspection_error ??
    (sameTracks && !data.inspection ? previous.inspection_error : undefined);

  if (!inspection && !inspection_error)
    throw new Error('Draft inspection is unavailable. Use Reload latest.');

  if (
    inspection &&
    (inspection.track_count !== draft.entries.length ||
      inspection.tracks.length !== draft.entries.length ||
      inspection.tracks.some(
        (track, index) => track.persistent_id !== draft.entries[index].track_id,
      ))
  )
    throw new Error('Draft inspection does not match its ordered tracks. Use Reload latest.');

  const keepTyped =
    same && (draft.revision === previous.draft.revision || typed !== previous.draft.feedback);

  return {
    state: { ...data, draft, inspection, inspection_error },
    feedback: keepTyped ? typed : draft.feedback,
    accepted: true,
  };
}

export function draftContext(state: DraftView) {
  const { draft_id, revision, entries, selected_entry_ids, feedback } = state.draft;

  return { draft_id, revision, entries, selected_entry_ids, feedback };
}

export function recoveredStatus(draft: Draft): { text: string; tone: 'ok' | 'error' | 'pending' } {
  const save = draft.save;

  if (!save) return { text: 'Latest local draft restored.', tone: 'ok' };

  if (save.status === 'pending')
    return {
      text: `Save outcome pending or unknown. Inspect Music.app before any further write.${save.result ? ` Stored outcome: ${JSON.stringify(save.result)}` : ''}`,
      tone: 'pending',
    };

  const parsed = DraftSaveOutcome.safeParse(save.result);
  const outcome = parsed.success ? parsed.data : undefined;

  if (typeof outcome?.error === 'string') {
    const summary = outcome.creation_committed
      ? 'Playlist creation committed; cleanup needs attention.'
      : 'Save failed.';

    return {
      text: `${summary} ${typeof outcome.hint === 'string' ? outcome.hint : outcome.error} ${JSON.stringify(outcome)}`,
      tone: 'error',
    };
  }

  if (
    typeof outcome?.playlist_id === 'string' &&
    outcome.playlist_id &&
    outcome.order_matches_request !== false
  )
    return { text: `Saved revision ${save.revision}. ${JSON.stringify(outcome)}`, tone: 'ok' };

  return {
    text: `Save outcome needs inspection. ${JSON.stringify(save.result ?? 'Outcome unknown; inspect Music.app before any further write.')}`,
    tone: 'pending',
  };
}
