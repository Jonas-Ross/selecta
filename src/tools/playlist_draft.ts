import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Appearance, DraftStore, type Draft } from '../drafts/store.js';
import { BridgeError } from '../types/errors.js';
import { handleInspectTracklist, inspectTracklistInputShape } from './inspect_tracklist.js';
import { handleCreatePlaylist } from './create_playlist.js';
import {
  isSelectaError,
  parseInput,
  toErrorEnvelope,
  validationError,
  type ToolDeps,
} from './common.js';

export const showDraftInputShape = {
  draft_id: z
    .string()
    .uuid()
    .describe('New UUID chosen for this draft; retained in tool input for reload recovery.'),
  name: z.string().trim().min(1).max(300),
  ...inspectTracklistInputShape,
};
export const getDraftInputShape = { draft_id: z.string().uuid() };
export const revisionInputShape = { ...getDraftInputShape, revision: z.number().int().positive() };
export const editDraftInputShape = {
  ...revisionInputShape,
  name: showDraftInputShape.name.optional(),
  entries: z
    .array(
      z.strictObject({
        entry_id: z
          .string()
          .uuid()
          .optional()
          .describe('Preserve existing occurrence IDs; omit only for a new entry.'),
        track_id: z.string().min(1),
      }),
    )
    .min(1)
    .max(500)
    .optional(),
  selected_entry_ids: z.array(z.string().uuid()).max(500).optional(),
  feedback: z.string().max(2000).optional(),
};

export const SHOW_DRAFT_DESCRIPTION = `Open an interactive playlist draft from ordered cached track_ids. Supply a new UUID as draft_id; this identity is also recoverable from the original tool input after reload. Local draft only: no playback or Music.app write. Each repeated ID gets a separate entry_id. Returns inspection facts, draft_id, revision and editable entries; works as JSON without UI. Selection identifies the subject of explicit feedback, not an instruction to replace or preserve tracks. Empty selection refers to the whole playlist. Use edit_playlist_draft with the returned revision and preserve existing entry_ids when revising. Widget context reaches Codex directly; in Claude Code retrieve Read widget context. Feedback messages may be staged in the composer for the user to send. After reload recover by get_playlist_draft using draft_id; never create a replacement silently. Save only on explicit user approval via save_playlist_draft with the exact revision.`;
export const EDIT_DRAFT_DESCRIPTION = `Edit local playlist draft at an exact revision: replace ordered entries, name, selection or feedback. Preserve entry_ids for existing occurrences including repeated tracks; omit entry_id for new occurrences. Selected entry IDs identify which occurrences the feedback refers to; empty selection means the whole playlist. Follow explicit feedback rather than inferring an action from selection alone. No Music.app calls. A stale revision fails: get_playlist_draft and reconcile rather than replaying. Returns the new revision and current cached inspection; removed library tracks remain recoverable but cannot be saved.`;
export const SAVE_DRAFT_DESCRIPTION = `Explicitly save the approved exact draft revision as a real Music.app playlist using create_playlist contracts. Never call for selection, reorder or feedback. Claims this revision before writing and stores the outcome, so duplicate or uncertain requests never automatically repeat a write. An operation_busy lock rejection releases the claim: wait, get the latest draft revision, then explicitly retry. Other errors retain the guard; inspect result/partial_write and Music.app before deciding a new draft revision is safe to save. A pending save after interruption is uncertain, not permission to retry. No fingerprint precondition, audition or preview-slot integration.`;

export class PlaylistDraftTools {
  constructor(
    private deps: ToolDeps,
    private store: DraftStore = new DraftStore(),
  ) {}

  appearance(input: unknown) {
    const parsed = parseInput(z.strictObject({ appearance: Appearance.optional() }), input);

    if (!parsed.ok) return parsed.error;

    try {
      return { appearance: this.store.appearance(parsed.data.appearance) };
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }

  private async view(draft: Draft) {
    const inspection = await handleInspectTracklist(
      { track_ids: draft.entries.map((entry) => entry.track_id) },
      this.deps,
    );

    return {
      draft,
      ...(isSelectaError(inspection) ? { inspection_error: inspection } : { inspection }),
    };
  }

  async show(raw: unknown) {
    const input = parseInput(z.strictObject(showDraftInputShape), raw);

    if (!input.ok) return input.error;

    try {
      const inspection = await handleInspectTracklist(
        { track_ids: input.data.track_ids },
        this.deps,
      );

      if (isSelectaError(inspection)) return inspection;

      return {
        draft: this.store.create(input.data.draft_id, input.data.name, input.data.track_ids),
        inspection,
      };
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }

  async get(raw: unknown) {
    const input = parseInput(z.strictObject(getDraftInputShape), raw);

    if (!input.ok) return input.error;

    try {
      return await this.view(this.store.get(input.data.draft_id));
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }

  async edit(raw: unknown) {
    const input = parseInput(z.strictObject(editDraftInputShape), raw);

    if (!input.ok) return input.error;

    const args = input.data;

    try {
      if (args.entries) {
        const inspection = await handleInspectTracklist(
          { track_ids: args.entries.map((entry) => entry.track_id) },
          this.deps,
        );

        if (isSelectaError(inspection)) return inspection;
      }

      const draft = this.store.update(args.draft_id, args.revision, (previous) => {
        if (previous.save?.status === 'pending')
          throw new BridgeError(
            'operation_busy',
            'Save outcome is pending. Inspect Music.app before further edits.',
          );

        const entries =
          args.entries?.map((entry) => {
            if (
              entry.entry_id &&
              !previous.entries.some(
                (old) => old.entry_id === entry.entry_id && old.track_id === entry.track_id,
              )
            ) {
              throw new BridgeError(
                'validation_error',
                'Entry identity cannot be reassigned.',
                'Existing entry_id must retain its track_id. Omit entry_id for new occurrences.',
              );
            }

            return { ...entry, entry_id: entry.entry_id ?? randomUUID() };
          }) ?? previous.entries;
        const ids = new Set(entries.map((entry) => entry.entry_id));
        const selection =
          args.selected_entry_ids ?? previous.selected_entry_ids.filter((id) => ids.has(id));

        if (
          ids.size !== entries.length ||
          new Set(selection).size !== selection.length ||
          selection.some((id) => !ids.has(id))
        ) {
          throw new BridgeError(
            'validation_error',
            'Invalid occurrence IDs.',
            'Entry IDs and selection must be unique; every selected ID must belong to this draft.',
          );
        }

        const contentChanged =
          (args.name !== undefined && args.name !== previous.name) ||
          JSON.stringify(entries.map((entry) => entry.track_id)) !==
            JSON.stringify(previous.entries.map((entry) => entry.track_id));

        return {
          ...previous,
          ...(contentChanged ? { save: undefined } : {}),
          entries,
          name: args.name ?? previous.name,
          selected_entry_ids: selection,
          feedback: args.feedback ?? previous.feedback,
        };
      });

      return await this.view(draft);
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }

  async save(raw: unknown) {
    const input = parseInput(z.strictObject(revisionInputShape), raw);

    if (!input.ok) return input.error;

    const { draft_id, revision } = input.data;

    try {
      const current = this.store.get(draft_id);

      if (current.revision !== revision)
        throw new BridgeError('draft_revision_conflict', 'Stale save request.');

      if (current.save)
        return validationError(
          'This draft already has a save attempt. Inspect its stored outcome before explicitly editing a new revision; do not retry the save unchanged.',
        );

      const inspection = await handleInspectTracklist(
        { track_ids: current.entries.map((entry) => entry.track_id) },
        this.deps,
      );

      if (isSelectaError(inspection)) return inspection;

      const claimed = this.store.update(draft_id, revision, (draft) => ({
        ...draft,
        save: { revision, status: 'pending' },
      }));
      const result = await handleCreatePlaylist(
        { name: claimed.name, track_ids: claimed.entries.map((entry) => entry.track_id) },
        this.deps,
      );

      try {
        // The operation lock rejects contention before running create's action.
        // Other errors can follow a write even without a partial-write receipt.
        const preWriteBusy =
          isSelectaError(result) && result.error === 'operation_busy' && !result.partial_write;
        const finished = this.store.update(draft_id, claimed.revision, (draft) => ({
          ...draft,
          save: preWriteBusy ? undefined : { revision, status: 'finished', result },
        }));

        return {
          draft: finished,
          saved_revision: revision,
          result,
          ...(isSelectaError(result) ? result : {}),
        };
      } catch (error) {
        // The Music.app outcome must survive a receipt persistence failure.
        // The durable pending claim blocks a repeat write after recovery.
        return {
          ...toErrorEnvelope(error),
          draft: claimed,
          saved_revision: revision,
          result,
          partial_write: isSelectaError(result)
            ? result.partial_write
            : { playlist_id: result.playlist_id },
          hint: 'Music.app returned an outcome but its draft receipt could not be persisted. Inspect result and the target playlist; the local save remains pending. Do not repeat the write.',
        };
      }
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }
}
