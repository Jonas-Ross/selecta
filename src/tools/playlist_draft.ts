import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DraftStore } from '../drafts/store.js';
import { withOperation, OperationCleanupError } from '../operations/lock.js';
import { replacePreview, type PreviewAttempt } from '../operations/preview_playlist.js';
import { PREVIEW_PLAYLIST_NAME } from '../operations/playlist.js';
import { missingTrackIdsError } from '../operations/resources.js';
import { Appearance, type Draft, type PreviewState } from '../drafts/contracts.js';
import { BridgeError, toErrorEnvelope } from '../types/errors.js';
import { handleInspectTracklist, inspectTracklistInputShape } from './inspect_tracklist.js';
import { creationResponse } from '../domain/playlist_creation.js';
import { createPlaylist } from '../operations/create_playlist.js';
import { isSelectaError, parseInput, validationError } from './errors.js';
import type { ToolDeps } from './deps.js';

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
export const previewDraftInputShape = {
  ...revisionInputShape,
  mode: z
    .enum(['start', 'adopt_live', 'detach'])
    .default('start')
    .describe(
      'Explicit start/recovery. adopt_live validates expected_track_ids and adopts live order locally; detach releases linkage locally, including an interrupted or missing preview. Neither recovery mode writes Music.app.',
    ),
  expected_track_ids: z
    .array(z.string().min(1))
    .max(500)
    .optional()
    .describe(
      'Explicit recovery only: exact live order inspected and reconciled by the user/agent, including repeats. Never guess or replay a failed baseline.',
    ),
};
export const PREVIEW_DRAFT_DESCRIPTION = `Start auditioning this exact draft revision in the shared Selecta Preview slot. Explicit start replaces the previous slot and links this draft: subsequent requested ordered-track edits synchronize it without separate confirmation. No permanent playlist is saved. Name, selection and feedback never write. Manual live-order drift stops replacement and preserves local edits. Failed/uncertain/pending sync requires inspection and explicit recovery with expected_track_ids matching the reconciled live order; no automatic retry. To preserve manual edits after an interrupted attempt, use mode:adopt_live with inspected expected_track_ids: validates live order and adopts it locally without a Music.app write. mode:detach explicitly releases this link locally (including missing/interrupted previews); reconcile edits then explicitly start a new preview. A different draft or raw preview takes ownership; old draft edits cannot reclaim it.`;
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
export const EDIT_DRAFT_DESCRIPTION = `Edit local playlist draft at an exact revision: replace ordered entries, name, selection or feedback. Preserve entry_ids for existing occurrences including repeated tracks; omit entry_id for new occurrences. Selected entry IDs identify which occurrences the feedback refers to; empty selection means the whole playlist. Follow explicit feedback rather than inferring an action from selection alone. When this draft owns an active preview, requested ordered-track changes also update Music.app without another confirmation. Name, selection and feedback-only changes never rewrite Music.app. Local edits succeed independently of preview conflict/failure; inspect preview.status/result and explicitly reconcile errors, never automatically retry. A stale revision fails: get_playlist_draft and reconcile rather than replaying. Returns the new revision and current cached inspection; removed library tracks remain recoverable but cannot be saved.`;
export const GET_DRAFT_DESCRIPTION = `Read-only recovery of a local draft by draft_id, including latest revision, edits, selection, feedback, save outcome and shared preview status. No Music.app call or draft mutation. Missing tracks return inspection_error alongside the recoverable draft. Missing drafts return a recovery hint.`;
export const SAVE_DRAFT_DESCRIPTION = `Explicitly save the approved exact draft revision as a real Music.app playlist using create_playlist contracts. Never call for selection, reorder or feedback. Claims this revision before writing and stores the outcome, so duplicate or uncertain requests never automatically repeat a write. A proven pre-write rejection (local preflight or a validated live creation guard) releases the claim: fix the cause, get the latest draft revision, then explicitly retry. Subprocess failures, including permission/app-not-running errors, do not prove that no write occurred and retain the guard; inspect result/partial_write and Music.app before deciding a new draft revision is safe to save. A pending save after interruption is uncertain, not permission to retry. An owned unresolved preview blocks saving: reconcile and synchronize the audition before approving permanent Save.`;

export class PlaylistDraftTools {
  private store: DraftStore;

  constructor(private deps: ToolDeps) {
    this.store = deps.drafts?.() ?? new DraftStore();
  }

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
      preview: this.previewState(draft.draft_id),
      ...(isSelectaError(inspection) ? { inspection_error: inspection } : { inspection }),
    };
  }

  private previewState(id: string): PreviewState | undefined {
    const slot = this.store.preview();

    return slot && slot.owner !== id
      ? { generation: slot.generation, version: slot.version, status: 'inactive' }
      : slot;
  }

  private async syncPreview(draft: Draft, explicit: boolean, expected?: string[]) {
    let claim: PreviewState | undefined;
    let result: PreviewAttempt | undefined;
    let preview: PreviewState | undefined;

    try {
      await withOperation(this.deps.cache(), 'music', async () => {
        const missing = missingTrackIdsError(
          this.deps.cache(),
          draft.entries.map((entry) => entry.track_id),
        );

        if (missing) {
          result = missing;

          return;
        }

        claim = this.store.claimPreview(draft.draft_id, draft.revision, explicit, expected);

        if (!claim) return;

        result = await replacePreview(
          draft.entries.map((entry) => entry.track_id),
          claim.baseline,
          this.deps,
        );
        const status =
          result.error === 'preview_conflict'
            ? 'conflict'
            : result.error
              ? result.observed_track_ids
                ? 'error'
                : 'uncertain'
              : result.order_matches_request
                ? 'current'
                : 'conflict';

        preview = this.store.finishPreview(claim, {
          status,
          result,
          baseline: result.observed_track_ids ?? claim.baseline,
          playlist_id: result.playlist_id ?? claim.playlist_id,
        });
      });
    } catch (error) {
      const failure = toErrorEnvelope(error, {
        error: 'cache_unavailable',
        hint: 'Local preview claim/receipt could not be persisted. Inspect the retained result; no automatic retry.',
      });
      const cleanup = error instanceof OperationCleanupError;

      result = {
        ...result,
        ...failure,
        hint: [result?.hint, failure.hint].filter(Boolean).join(' '),
        ...(cleanup
          ? {
              error: 'operation_cleanup_failed',
              lock_path: error.lockPath,
              hint: error.recoveryHint,
            }
          : {}),
      };

      // Retain the settled write receipt in the response even if storage or lock cleanup failed.
      if (claim) {
        preview = { ...(preview ?? claim), status: 'error', result };

        if (cleanup) {
          try {
            preview = this.store.finishPreview(claim, preview);
          } catch (persistenceError) {
            result.hint = `${result.hint} Cleanup warning could not be persisted: ${String(persistenceError)}.`;
          }
        }
      }
    }

    return { preview, preview_result: result };
  }

  private async afterSync(
    draft: Draft,
    sync: Awaited<ReturnType<PlaylistDraftTools['syncPreview']>>,
  ) {
    try {
      const latest = await this.view(this.store.get(draft.draft_id));
      const preview =
        sync.preview && (latest.preview?.version ?? -1) <= sync.preview.version
          ? sync.preview
          : latest.preview;

      return { ...latest, preview, preview_result: sync.preview_result };
    } catch (error) {
      // A persistent storage outage must not erase a known Music.app outcome.
      const inspection = await handleInspectTracklist(
        { track_ids: draft.entries.map((entry) => entry.track_id) },
        this.deps,
      );

      return {
        draft,
        ...(isSelectaError(inspection) ? { inspection_error: inspection } : { inspection }),
        preview: sync.preview,
        preview_result: sync.preview_result,
        recovery_error: toErrorEnvelope(error, {
          error: 'cache_unavailable',
          hint: 'Latest draft state unavailable. Retain this last known draft and preview receipt; inspect before recovery.',
        }),
      };
    }
  }

  private async adoptPreview(draft: Draft, expected: string[]) {
    let originalSlot: PreviewState | undefined;
    let result: PreviewAttempt | undefined;
    let preview: PreviewState | undefined;

    try {
      await withOperation(this.deps.cache(), 'music', async () => {
        const slot = this.store.preview();

        originalSlot = slot;

        if (slot?.owner !== draft.draft_id)
          throw new BridgeError('preview_conflict', 'This draft no longer owns the preview.');

        const missing = missingTrackIdsError(this.deps.cache(), expected);

        if (missing) throw new BridgeError(missing.error, missing.hint);

        const observed = await this.deps.bridge.readPreview({
          name: PREVIEW_PLAYLIST_NAME,
          expectedTrackIds: expected,
        });

        result = {
          playlist_id: observed.persistentId,
          observed_track_ids: observed.trackPersistentIds,
          order_matches_request: true,
        };
        draft = this.store.adoptPreview(
          draft.draft_id,
          draft.revision,
          slot.generation,
          observed.persistentId,
          observed.trackPersistentIds,
        );
        preview = this.store.preview();
      });
    } catch (error) {
      result = {
        ...result,
        ...toErrorEnvelope(error, {
          error: 'cache_unavailable',
          hint: 'Could not adopt the live preview; Music.app was not changed.',
        }),
      };

      if (
        error instanceof BridgeError &&
        error.errorCode === 'preview_conflict' &&
        originalSlot?.owner === draft.draft_id
      ) {
        preview = { ...originalSlot, status: 'conflict', result };

        try {
          preview = this.store.finishPreview(originalSlot, preview);
        } catch {
          /* The returned conflict still requires reconciliation. */
        }
      }

      if (error instanceof OperationCleanupError) {
        result = {
          ...result,
          error: 'operation_cleanup_failed',
          lock_path: error.lockPath,
          hint: error.recoveryHint,
        };

        if (preview) {
          preview = { ...preview, status: 'error', result };

          try {
            preview = this.store.finishPreview(preview, preview);
          } catch {
            /* Returned receipt survives storage failure. */
          }
        }
      }
    }

    return this.afterSync(draft, { preview, preview_result: result });
  }

  async preview(raw: unknown) {
    const input = parseInput(z.strictObject(previewDraftInputShape), raw);

    if (!input.ok) return input.error;

    try {
      const draft = this.store.get(input.data.draft_id);

      if (draft.revision !== input.data.revision)
        throw new BridgeError('draft_revision_conflict', 'Stale preview request.');

      if (input.data.mode === 'detach') {
        await withOperation(this.deps.cache(), 'music', async () => {
          this.store.detachPreview(draft.draft_id, draft.revision);
        });

        return await this.view(draft);
      }

      if (input.data.mode === 'adopt_live') {
        if (!input.data.expected_track_ids?.length)
          return validationError(
            'Adopting the live preview requires 1-500 inspected expected_track_ids.',
          );

        return await this.adoptPreview(draft, input.data.expected_track_ids);
      }

      const sync = await this.syncPreview(draft, true, input.data.expected_track_ids);

      return await this.afterSync(draft, sync);
    } catch (error) {
      return toErrorEnvelope(error);
    }
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
    let tracksChanged = false;

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
            'Save outcome is pending.',
            'A save of this draft is pending with an unknown outcome and never clears on its own. Inspect Music.app for the playlist before further edits; do not retry the save.',
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

        tracksChanged =
          JSON.stringify(entries.map((entry) => entry.track_id)) !==
          JSON.stringify(previous.entries.map((entry) => entry.track_id));
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

      const sync = tracksChanged
        ? await this.syncPreview(draft, false)
        : { preview: undefined, preview_result: undefined };

      return { ...(await this.afterSync(draft, sync)), local_edit_saved: true };
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
      const outcome = await createPlaylist(
        { name: claimed.name, trackIds: claimed.entries.map((entry) => entry.track_id) },
        this.deps,
      );
      const result = creationResponse(outcome);

      try {
        const preWrite = outcome.status === 'rejected_before_write';
        const finished = this.store.update(draft_id, claimed.revision, (draft) => ({
          ...draft,
          save: preWrite ? undefined : { revision, status: 'finished', result },
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
          partial_write:
            'observed' in outcome
              ? {
                  playlist_id: outcome.observed.playlist.persistentId,
                  observed_track_ids: outcome.observed.playlist.trackPersistentIds,
                }
              : outcome.error.partial_write,
          hint:
            outcome.status === 'rejected_before_write'
              ? 'Creation was rejected before any write, but releasing the draft claim failed. The local save remains pending. Repair local draft storage and inspect the latest draft; do not repeat the save.'
              : outcome.status === 'write_uncertain'
                ? 'The Music.app write outcome is uncertain and its draft receipt could not be persisted. Inspect result and Music.app; the local save remains pending. Do not repeat the write.'
                : 'Music.app returned an outcome but its draft receipt could not be persisted. Inspect result and the target playlist; the local save remains pending. Do not repeat the write.',
        };
      }
    } catch (error) {
      return toErrorEnvelope(error);
    }
  }
}
