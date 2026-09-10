import { describe, expect, it } from 'vitest';
import { planSyncReconciliation, type ReconciliationInput } from '../src/cache/reconciliation.js';

function receipt(overrides: Partial<ReconciliationInput> = {}): ReconciliationInput {
  return {
    creation: {
      createdPersistentId: 'CREATED',
      currentPersistentId: 'CURRENT',
      name: 'Mix',
      trackIds: ['A', 'B', 'A'],
      createdAt: '2026-06-01T12:00:00.000Z',
    },
    candidates: [{ id: 'NEW', trackIds: ['A', 'B', 'A'] }],
    currentExists: false,
    ...overrides,
  };
}

describe('pure reconciliation planner', () => {
  it('preserves repeated entries and order when matching an ordinary receipt', () => {
    const input = receipt();

    expect(planSyncReconciliation([input])).toEqual([
      { kind: 'rekey', createdId: 'CREATED', name: 'Mix', fromId: 'CURRENT', toId: 'NEW' },
    ]);

    for (const trackIds of [
      ['A', 'B'],
      ['A', 'A', 'B'],
    ]) {
      expect(planSyncReconciliation([receipt({ candidates: [{ id: 'NEW', trackIds }] })])).toEqual(
        [],
      );
    }
  });

  it('does not rekey a current ID that survives outside the same-name candidates', () => {
    // The current playlist may have been renamed, so presence cannot be
    // inferred solely from the candidate list for the receipt's old name.
    expect(planSyncReconciliation([receipt({ currentExists: true })])).toEqual([]);
    expect(planSyncReconciliation([receipt({ currentExists: true })], ['Mix'])).toEqual([]);
  });

  it('retains receipt order and reports each ambiguous name once without changing inputs', () => {
    const ambiguous = receipt({
      candidates: [
        { id: 'FIRST', trackIds: [] },
        { id: 'SECOND', trackIds: ['B'] },
      ],
    });
    const ordinary = receipt();
    const inputs = [
      ambiguous,
      { ...ordinary, creation: { ...ordinary.creation, name: 'Other' } },
      { ...ambiguous, creation: { ...ambiguous.creation, createdPersistentId: 'SECOND-RECEIPT' } },
    ];
    const before = structuredClone(inputs);
    const expected = [
      { kind: 'ambiguous', name: 'Mix', playlistIds: ['FIRST', 'SECOND'] },
      { kind: 'rekey', createdId: 'CREATED', name: 'Other', fromId: 'CURRENT', toId: 'NEW' },
    ];

    expect(planSyncReconciliation(inputs, ['Mix'])).toEqual(expected);
    expect(planSyncReconciliation(inputs, ['Mix'])).toEqual(expected);
    expect(inputs).toEqual(before);
  });
});
