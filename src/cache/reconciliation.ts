// Pure receipt matching. The facade loads candidate rows and owns any reads or writes.
import type { PlaylistCreationRow, ReconcileAction } from '../types/cache.js';

export type ReconciliationInput = {
  creation: Readonly<PlaylistCreationRow>;
  candidates: readonly { id: string; trackIds: readonly string[] }[];
  currentExists: boolean;
};

export function planSyncReconciliation(
  inputs: readonly ReconciliationInput[],
  reservedSlotNames: readonly string[] = [],
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];

  for (const { creation, candidates, currentExists } of inputs) {
    const wanted = JSON.stringify(creation.trackIds);
    const sameNameIds = candidates.map((candidate) => candidate.id);
    const matchIds = candidates
      .filter((candidate) => JSON.stringify(candidate.trackIds) === wanted)
      .map((candidate) => candidate.id);
    const currentId = creation.currentPersistentId;
    // A reserved slot rekeys by name alone, so several same-name copies
    // are ambiguous regardless of sequence; any other receipt rekeys to
    // the single exact-sequence match.
    const rekeyId = reservedSlotNames.includes(creation.name)
      ? sameNameIds.length === 1
        ? sameNameIds[0]!
        : null
      : matchIds.length === 1
        ? matchIds[0]!
        : null;

    if (rekeyId !== null && rekeyId !== currentId && sameNameIds.length === 1 && !currentExists) {
      actions.push({
        kind: 'rekey',
        createdId: creation.createdPersistentId,
        name: creation.name,
        fromId: currentId,
        toId: rekeyId,
      });
    } else if (
      sameNameIds.length >= 2 &&
      !actions.some((a) => a.kind === 'ambiguous' && a.name === creation.name)
    ) {
      actions.push({ kind: 'ambiguous', name: creation.name, playlistIds: sameNameIds });
    }
  }

  return actions;
}
