import { afterEach, expect, it, vi } from 'vitest';
import {
  createDraftController,
  type DraftDependencies,
  type DraftHost,
} from '../ui/draft-controller.js';
import { acceptDraftResponse, decodeDraftResult, recoveredStatus } from '../ui/draft-state.js';
import { Draft, type DraftView } from '../src/drafts/contracts.js';
import { Element } from './dom.js';

const id = '00000000-0000-4000-8000-000000000001';
const entries = [1, 2].map((n) => ({
  entry_id: `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`,
  track_id: 'same',
}));
const initial = (): DraftView => ({
  draft: {
    draft_id: id,
    revision: 1,
    name: 'Fixture',
    feedback: '',
    entries,
    selected_entry_ids: [],
  },
  inspection: {
    track_count: 2,
    tracks: entries.map(() => ({
      persistent_id: 'same',
      title: 'Repeated',
      artist: 'Artist',
      duration_seconds: 100,
    })),
    runtime: { known_seconds: 200, missing_count: 0 },
    duplicate_ids: [{ persistent_id: 'same', count: 2, positions: [0, 1] }],
    duplicate_owned_copies: [],
    artist_counts: [{ artist: 'Artist', count: 2 }],
    unknown_artist_count: 0,
    feature_coverage: { bpm: { missing_count: 2 } },
  },
});
const wire = (data: Record<string, unknown>, isError = false) => ({
  structuredContent: data,
  content: [],
  isError,
});

class Control extends Element {
  open = false;
  focus = vi.fn();
  addEventListener = vi.fn();
  querySelector = vi.fn();
}

function fixture() {
  const nodes = new Map<string, Control>();
  const el = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Control());

    return nodes.get(id)!;
  };
  let current = initial();
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const app = {
    connect: vi.fn(async () => {}),
    callServerTool: vi.fn(
      async (request: { name: string; arguments?: Record<string, unknown> }) => {
        calls.push(request);

        if (request.name === 'playlist_draft_appearance')
          return wire({ appearance: request.arguments?.appearance ?? 'host' });

        if (request.name === 'edit_playlist_draft') {
          current = {
            ...current,
            draft: Draft.parse({
              ...current.draft,
              ...request.arguments,
              revision: current.draft.revision + 1,
            }),
          };
        }

        return wire(current);
      },
    ),
    sendMessage: vi.fn<DraftHost['sendMessage']>().mockResolvedValue({ isError: false }),
    updateModelContext: vi.fn<DraftHost['updateModelContext']>().mockResolvedValue({}),
    getHostContext: () => ({ theme: 'dark' as const }),
    sendSizeChanged: vi.fn(async () => {}),
    ontoolinput: undefined as DraftHost['ontoolinput'],
    ontoolresult: undefined as DraftHost['ontoolresult'],
    onhostcontextchanged: undefined as DraftHost['onhostcontextchanged'],
  };
  const ui = { activeElement: el('feedback'), addEventListener: vi.fn() };
  const applyHostStyleVariables = vi.fn();
  // The small controlled DOM deliberately implements only the surface used by
  // controller/rendering. This cast is the fixture's DOM adapter, not host data.
  const controller = createDraftController(app, {
    host: el('host'),
    ui,
    el,
    observeSize: vi.fn(),
    applyHostStyleVariables,
  } as unknown as DraftDependencies);

  async function start() {
    await controller.connect();
    await controller.recover(id);
    calls.length = 0;
  }

  return {
    el,
    app,
    calls,
    controller,
    start,
    applyHostStyleVariables,
    setCurrent: (value: DraftView) => {
      current = value;
    },
    result: (data: DraftView) => app.ontoolresult?.(wire(data)),
  };
}

afterEach(() => vi.useRealTimers());

it('imports without connecting and never saves without the explicit save action', async () => {
  const f = fixture();

  expect(f.app.connect).not.toHaveBeenCalled();
  await f.start();
  await f.controller.edit({ selected_entry_ids: [entries[1].entry_id] });
  expect(f.calls.map((call) => call.name)).toEqual(['edit_playlist_draft']);
  expect(f.app.updateModelContext.mock.calls[0][0].content?.[0]).toMatchObject({
    text: expect.stringContaining(entries[1].entry_id),
  });
});

it('preserves typed feedback through replays, reloads, newer revisions and receipts', () => {
  const previous = initial();

  for (const revision of [1, 2]) {
    const next = acceptDraftResponse(
      previous,
      { ...previous, draft: { ...previous.draft, revision, feedback: 'agent text' } },
      'unsent typing',
    );

    expect(next.feedback).toBe('unsent typing');
  }

  expect(
    acceptDraftResponse(
      previous,
      { ...previous, draft: { ...previous.draft, revision: 2, feedback: 'agent text' } },
      '',
    ).feedback,
  ).toBe('agent text');
  expect(
    acceptDraftResponse(
      previous,
      {
        ...previous,
        draft: {
          ...previous.draft,
          draft_id: '00000000-0000-4000-8000-000000000002',
          feedback: 'other',
        },
      },
      'unsent',
    ).feedback,
  ).toBe('other');
});

it('rejects older revisions without changing feedback, selection or keyed nodes', async () => {
  const f = fixture();

  await f.start();
  await f.controller.edit({ selected_entry_ids: [entries[1].entry_id] });
  const rows = [...f.el('tracks').children];

  f.el('feedback').value = 'still typing';
  f.setCurrent(initial());
  f.result(initial());
  await vi.waitFor(() => expect(f.el('editor').inert).toBe(false));
  expect(f.el('revision').textContent).toBe('Revision 2');
  expect(f.el('feedback').value).toBe('still typing');
  expect(f.el('tracks').children).toEqual(rows);
  expect(rows[1].children[0].checked).toBe(true);
});

it('keeps row identity and restores focus across an edit and failed context delivery', async () => {
  const f = fixture();

  await f.start();
  f.app.updateModelContext.mockRejectedValueOnce(new Error('offline'));
  const rows = [...f.el('tracks').children];

  await f.controller.edit({ entries: [...entries].reverse() });
  expect(f.el('tracks').children).toEqual([...rows].reverse());
  expect(f.el('feedback').focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(f.el('status').textContent).toContain('Context delivery failed');
  expect(f.el('editor').inert).toBe(false);
});

it.each(['rejection', 'exception'])(
  'keeps saved feedback after host message %s and allows another explicit send',
  async (mode) => {
    const f = fixture();

    await f.start();
    f.el('feedback').value = 'Keep the second occurrence';

    if (mode === 'rejection') f.app.sendMessage.mockResolvedValueOnce({ isError: true });
    else f.app.sendMessage.mockRejectedValueOnce(new Error('Host offline'));

    await f.el('send').onclick();
    expect(f.el('status').dataset.tone).toBe('error');
    expect(f.el('feedback').value).toBe('Keep the second occurrence');
    expect(f.app.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.calls.filter((call) => call.name === 'edit_playlist_draft')).toHaveLength(1);
    await f.el('send').onclick();
    expect(f.app.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((call) => call.name === 'edit_playlist_draft')).toHaveLength(1);
    expect(f.el('status').dataset.tone).toBe('ok');
    expect(f.app.sendMessage.mock.calls[1][0].content[0]).toMatchObject({
      text: expect.stringContaining('Keep the second occurrence'),
    });
  },
);

it('does not send feedback after a stale edit fails and retains local typing', async () => {
  const f = fixture();

  await f.start();
  f.el('feedback').value = 'unsent';
  f.app.callServerTool.mockResolvedValueOnce(
    wire({ error: 'draft_revision_conflict', hint: 'Now revision 3. Reconcile.' }, true),
  );
  await f.el('send').onclick();
  expect(f.app.sendMessage).not.toHaveBeenCalled();
  expect(f.el('feedback').value).toBe('unsent');
  expect(f.el('status').textContent).toContain('Now revision 3. Reconcile.');
});

it('reports connection and recovery failures without retrying or losing accepted state', async () => {
  const failed = fixture();

  failed.app.connect.mockRejectedValueOnce(new Error('Disconnected'));
  await failed.controller.connect();
  expect(failed.el('status').textContent).toContain('Host connection failed: Disconnected');
  expect(failed.app.callServerTool).not.toHaveBeenCalled();
  const f = fixture();

  await f.start();
  f.el('feedback').value = 'unsent';
  f.app.callServerTool.mockRejectedValueOnce(new Error('Recovery unavailable'));
  await f.controller.recover(id);
  expect(f.el('revision').textContent).toBe('Revision 1');
  expect(f.el('feedback').value).toBe('unsent');
  expect(f.el('status').textContent).toContain('Recovery unavailable');
  expect(f.calls).toHaveLength(0);
  expect(f.el('editor').inert).toBe(false);
});

it.each([
  null,
  [],
  { draft: { revision: 4 } },
  { ...initial(), inspection: {} },
  { ...initial(), inspection: { ...initial().inspection, tracks: [] } },
])('rejects malformed host payload %j before accepting state', async (data) => {
  const f = fixture();

  await f.start();
  f.el('feedback').value = 'unsent';
  f.app.callServerTool.mockResolvedValueOnce({
    structuredContent: data,
    content: [],
    isError: false,
  } as unknown as ReturnType<typeof wire>);
  await f.controller.recover(id);
  expect(f.el('revision').textContent).toBe('Revision 1');
  expect(f.el('feedback').value).toBe('unsent');
  expect(f.el('status').dataset.tone).toBe('error');
});

it('rejects mismatched inspection identities and invalid occurrence selections', () => {
  const data = initial();

  expect(() =>
    acceptDraftResponse(
      undefined,
      {
        ...data,
        inspection: {
          ...data.inspection!,
          tracks: [{ persistent_id: 'other' }, { persistent_id: 'same' }],
        },
      },
      '',
    ),
  ).toThrow('ordered tracks');
  expect(() =>
    acceptDraftResponse(
      undefined,
      { ...data, draft: { ...data.draft, entries: [entries[0], entries[0]] } },
      '',
    ),
  ).toThrow('occurrence IDs');
  expect(() =>
    acceptDraftResponse(
      undefined,
      { ...data, draft: { ...data.draft, selected_entry_ids: [id] } },
      '',
    ),
  ).toThrow('occurrence IDs');
});

it('reads JSON text results and preserves plain-text tool failure messages', () => {
  expect(
    decodeDraftResult({ content: [{ type: 'text', text: JSON.stringify(initial()) }] }).data?.draft,
  ).toEqual(initial().draft);
  expect(
    decodeDraftResult({ isError: true, content: [{ type: 'text', text: 'Database unavailable' }] })
      .error,
  ).toBe('Database unavailable');
});

it.each([
  [{ revision: 1, status: 'pending' }, 'pending'],
  [
    {
      revision: 1,
      status: 'finished',
      result: { playlist_id: 'saved', order_matches_request: true },
    },
    'ok',
  ],
  [
    {
      revision: 1,
      status: 'finished',
      result: {
        error: 'bridge_failed',
        hint: 'Partial write',
        partial_write: { playlist_id: 'partial' },
      },
    },
    'error',
  ],
  [{ revision: 1, status: 'finished' }, 'pending'],
  [
    {
      revision: 1,
      status: 'finished',
      result: { playlist_id: 'saved', order_matches_request: false },
    },
    'pending',
  ],
] as const)('derives recovered tone from stored outcome %j', async (save, tone) => {
  const f = fixture();
  const data = initial();

  f.setCurrent({ ...data, draft: { ...data.draft, save } });
  await f.start();
  expect(f.el('status').dataset.tone).toBe(tone);
  expect(f.el('save').disabled).toBe(true);
  expect(f.el('feedback').disabled).toBe(save.status === 'pending');
  expect(recoveredStatus({ ...data.draft, save }).tone).toBe(tone);
});

it('accepts error receipts and keeps unknown receipt fields and pending guard visible', async () => {
  const f = fixture();
  const data = initial();

  data.draft.entries = Array.from({ length: 500 }, (_, index) => ({
    entry_id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
    track_id: 'same',
  }));
  data.inspection!.track_count = 500;
  data.inspection!.tracks = data.draft.entries.map(() => ({ persistent_id: 'same' }));
  f.setCurrent(data);
  await f.start();
  f.el('feedback').value = 'unsent';
  const receipt = {
    draft: { ...data.draft, revision: 2, save: { revision: 1, status: 'pending' } },
    error: 'cache_unavailable',
    hint: 'Receipt persistence failed',
    result: { playlist_id: 'created', future_receipt_field: { durable: false } },
    partial_write: { playlist_id: 'created' },
    saved_revision: 1,
    future_top_level: 'retained',
  };

  f.app.callServerTool.mockResolvedValueOnce(wire(receipt, true));
  await f.el('save').onclick();
  expect(f.el('revision').textContent).toBe('Revision 2');
  expect(f.el('save').disabled).toBe(true);
  expect(f.el('status').textContent).toContain('Receipt persistence failed');
  expect(f.el('status').textContent).toContain('future_receipt_field');
  expect(f.el('status').textContent).toContain('created');
  expect(f.el('status').textContent).toContain('"partial_write"');
  expect(f.el('status').textContent).toContain('"saved_revision":1');
  expect(f.el('status').textContent).not.toContain('"entries"');
  expect(f.el('status').textContent).not.toContain('"draft"');
  expect(f.el('status').textContent).not.toContain('future_top_level');
  expect(f.el('feedback').value).toBe('unsent');
  expect(decodeDraftResult(wire(receipt, true)).data?.future_top_level).toBe('retained');
});

it('preserves receipts in an invalid failed save without accepting its malformed draft', async () => {
  const f = fixture();

  await f.start();
  f.app.callServerTool.mockResolvedValueOnce(
    wire(
      {
        draft: { revision: 8 },
        error: 'failed',
        hint: 'Inspect target',
        partial_write: { playlist_id: 'partial' },
      },
      true,
    ),
  );
  await f.el('save').onclick();
  expect(f.el('revision').textContent).toBe('Revision 1');
  expect(f.el('status').textContent).toContain('partial');
  expect(f.el('status').textContent).toContain('Inspect target');
  expect(f.el('status').textContent).not.toContain('"draft"');
});

it('retains palette, host theme and typing through appearance changes and errors', async () => {
  const f = fixture();

  await f.start();
  f.el('feedback').value = 'unsent';
  f.el('appearance').value = 'oled';
  await f.el('appearance').onchange();
  expect(f.el('host').dataset.palette).toBe('oled');
  expect(f.el('host').style.colorScheme).toBe('dark');
  f.app.onhostcontextchanged?.({
    theme: 'light',
    styles: { variables: { '--color-text-primary': 'red' } },
  });
  expect(f.el('host').style.colorScheme).toBe('dark');
  expect(f.applyHostStyleVariables).toHaveBeenCalled();
  f.app.callServerTool.mockResolvedValueOnce(wire({ appearance: 'unknown' }));
  await f.el('appearance').onchange();
  expect(f.el('appearance').value).toBe('oled');
  expect(f.el('appearance').disabled).toBe(false);
  expect(f.el('feedback').value).toBe('unsent');
  expect(f.el('status').textContent).toContain('Appearance unavailable');
});

it('recovers a replay received during connection and cancels the input fallback', async () => {
  vi.useFakeTimers();
  const f = fixture();

  f.app.connect.mockImplementationOnce(async () => {
    f.app.ontoolinput?.({ arguments: { draft_id: id } });
    f.result(initial());
  });
  await f.controller.connect();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.calls.filter((call) => call.name === 'get_playlist_draft')).toHaveLength(1);
  expect(f.el('revision').textContent).toBe('Revision 1');
});

it('recovers input-only delivery after the grace period and makes no write', async () => {
  vi.useFakeTimers();
  const f = fixture();

  await f.controller.connect();
  f.calls.length = 0;
  f.app.ontoolinput?.({ arguments: { draft_id: id } });
  await vi.advanceTimersByTimeAsync(1499);
  expect(f.calls).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls.map((call) => call.name)).toEqual(['get_playlist_draft']);
});

it('keeps edits on the accepted draft when a late input names another draft', async () => {
  vi.useFakeTimers();
  const f = fixture();

  await f.start();
  f.el('feedback').value = 'Keep my current draft';
  f.app.ontoolinput?.({ arguments: { draft_id: '00000000-0000-4000-8000-000000000002' } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.calls).toHaveLength(0);
  await f.el('keep-feedback').onclick();
  expect(f.calls).toEqual([
    {
      name: 'edit_playlist_draft',
      arguments: { draft_id: id, revision: 1, feedback: 'Keep my current draft' },
    },
  ]);
});

it('clears an old inspection error when a fresh inspection resolves the tracks', async () => {
  const f = fixture();
  const data = initial();

  f.setCurrent({
    draft: data.draft,
    inspection_error: { error: 'track_not_found', hint: 'Missing track' },
  });
  await f.start();
  expect(f.el('save').disabled).toBe(true);
  f.setCurrent(data);
  await f.controller.recover(id);
  expect(f.el('save').disabled).toBe(false);
  expect(f.el('summary').textContent).toContain('2 tracks');
});

it('shows the receipt when a failed save also fails semantic occurrence validation', async () => {
  const f = fixture();

  await f.start();
  const data = initial();

  f.app.callServerTool.mockResolvedValueOnce(
    wire(
      {
        draft: { ...data.draft, revision: 3, entries: [entries[0], entries[0]] },
        error: 'partial_failure',
        hint: 'Inspect Music.app',
        result: {
          error: 'bridge_failed',
          partial_write: { playlist_id: 'partial', observed_track_ids: ['same'] },
        },
        partial_write: { playlist_id: 'partial', observed_track_ids: ['same'] },
      },
      true,
    ),
  );
  await f.el('save').onclick();
  expect(f.el('revision').textContent).toBe('Revision 1');
  expect(f.el('status').textContent).toContain('Invalid draft occurrence IDs');
  expect(f.el('status').textContent).toContain('Inspect Music.app');
  expect(f.el('status').textContent).toContain('observed_track_ids');
  expect(f.el('status').textContent).toContain('partial');
  expect(f.el('status').textContent).not.toContain('"entries"');
});

it.each([
  wire({ error: 'draft_not_found', hint: 'Original creation failed' }, true),
  wire({ draft: { revision: 1 } }),
])(
  'preserves a failed result delivered during connection and does not recover a failed show',
  async (result) => {
    const f = fixture();

    f.app.connect.mockImplementationOnce(async () => {
      f.app.ontoolinput?.({ arguments: { draft_id: id } });
      f.app.ontoolresult?.(result);
    });
    await f.controller.connect();
    expect(f.el('status').dataset.tone).toBe('error');
    expect(f.el('status').textContent).not.toContain('Ready');
    expect(f.calls.map((call) => call.name)).toEqual(['playlist_draft_appearance']);
  },
);

it('does not write twice during one pending save action', async () => {
  const f = fixture();

  await f.start();
  let complete!: (value: ReturnType<typeof wire>) => void;

  f.app.callServerTool.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const first = f.el('save').onclick();

  expect(f.el('editor').inert).toBe(true);
  await f.el('save').onclick();
  const data = initial();

  complete(
    wire({
      draft: {
        ...data.draft,
        revision: 3,
        save: {
          revision: 1,
          status: 'finished',
          result: { playlist_id: 'created', order_matches_request: true },
        },
      },
    }),
  );
  await first;
  expect(
    f.app.callServerTool.mock.calls.filter(([request]) => request.name === 'save_playlist_draft'),
  ).toHaveLength(1);
  expect(f.el('status').dataset.tone).toBe('ok');
  expect(f.el('save').disabled).toBe(true);
});

it('keeps malformed outcome fields visible as uncertainty rather than success', () => {
  const draft = initial().draft;

  expect(
    recoveredStatus({
      ...draft,
      save: {
        revision: 1,
        status: 'finished',
        result: { playlist_id: 'target', order_matches_request: 'unknown' },
      },
    }),
  ).toEqual({
    text: expect.stringContaining('"order_matches_request":"unknown"'),
    tone: 'pending',
  });
  expect(
    recoveredStatus({
      ...draft,
      save: {
        revision: 1,
        status: 'pending',
        result: { partial_write: { playlist_id: 'partial' } },
      },
    }).text,
  ).toContain('partial');
});

it('keeps committed creation and stale-lock guidance visible through save recovery', async () => {
  const f = fixture();

  await f.start();
  const data = initial();
  const result = {
    playlist_id: 'created',
    name: data.draft.name,
    track_count: 2,
    error: 'operation_cleanup_failed',
    creation_committed: true,
    lock_path: '/fixture/library.db.music.lock',
    hint: 'Creation committed to Music.app and the cache. Stop Selecta processes and inspect the stale lock at /fixture/library.db.music.lock. No refresh or repeat creation is needed.',
    note: { body: 'Keep this note', created_at: '2026-09-10', updated_at: '2026-09-10' },
    partial_write: { playlist_id: 'created', observed_track_ids: ['same', 'same'] },
  };
  const draft: Draft = {
    ...data.draft,
    revision: 3,
    save: { revision: 1, status: 'finished', result },
  };

  f.app.callServerTool.mockResolvedValueOnce(
    wire({ draft, saved_revision: 1, result, ...result }, true),
  );
  await f.el('save').onclick();
  expect(f.el('status').textContent).toContain(result.hint);
  expect(f.el('status').textContent).toContain('Keep this note');
  expect(f.el('save').disabled).toBe(true);
  f.setCurrent({ ...data, draft });
  await f.controller.recover(id);
  expect(f.el('status').textContent).toContain('creation committed');
  expect(f.el('status').textContent).toContain(result.lock_path);
  expect(f.el('status').textContent).not.toContain('Save failed');
  expect(f.el('status').dataset.tone).toBe('error');
  await f.el('save').onclick();
  expect(
    f.app.callServerTool.mock.calls.filter(([request]) => request.name === 'save_playlist_draft'),
  ).toHaveLength(1);
});
