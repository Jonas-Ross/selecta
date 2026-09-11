import type { App } from '@modelcontextprotocol/ext-apps';
import type { z } from 'zod';
import {
  Appearance,
  type Draft,
  type DraftResponse,
  type DraftView,
} from '../src/drafts/contracts.js';
import {
  acceptDraftResponse,
  decodeDraftResult,
  draftContext,
  errorMessage,
  recoveredStatus,
} from './draft-state.js';
import { renderDraft } from './render.js';

type HostContext = NonNullable<ReturnType<App['getHostContext']>>;
export type DraftHost = Pick<
  App,
  | 'connect'
  | 'callServerTool'
  | 'sendMessage'
  | 'updateModelContext'
  | 'getHostContext'
  | 'sendSizeChanged'
  | 'ontoolinput'
  | 'ontoolresult'
  | 'onhostcontextchanged'
>;
export type DraftElements = {
  appearance: HTMLSelectElement;
  feedback: HTMLTextAreaElement;
  'recover-id': HTMLInputElement;
  'timeline-tempo': HTMLInputElement;
  'timeline-key': HTMLInputElement;
  options: HTMLDetailsElement;
  status: HTMLElement;
  'feedback-panel': HTMLElement;
} & Record<
  'recover' | 'reload' | 'keep-feedback' | 'send' | 'save' | 'feedback-toggle',
  HTMLButtonElement
>;
export interface DraftDependencies {
  host: HTMLElement;
  ui: Pick<ShadowRoot, 'activeElement' | 'addEventListener'>;
  el: <K extends keyof DraftElements>(id: K) => DraftElements[K];
  observeSize: (host: HTMLElement, report: (height: number) => void) => unknown;
  applyHostStyleVariables: (
    variables: NonNullable<NonNullable<HostContext['styles']>['variables']>,
  ) => void;
}

/** Host and DOM are injected; importing the controller has no connection side effects. */
export function createDraftController(
  app: DraftHost,
  { host, ui, el, observeSize, applyHostStyleVariables }: DraftDependencies,
) {
  let state: DraftView | undefined;
  let draftId: string | undefined;
  let busy = false;
  let connected = false;
  let receivedResult = false;
  let failedResult = false;
  // tone: 'ok' | 'error' | 'pending' | undefined (neutral). The dot in front of
  // the line is what makes a failed save look different from a restored draft.
  const status = (text: string, tone?: 'ok' | 'error' | 'pending') => {
    el('status').textContent = text;

    if (tone) el('status').dataset.tone = tone;
    else delete el('status').dataset.tone;
  };

  let hostTheme: 'light' | 'dark' | undefined;
  let appearance: z.infer<typeof Appearance> = 'host';

  function theme(context?: HostContext) {
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);

    if (context?.theme) hostTheme = context.theme;

    host.style.colorScheme = appearance === 'oled' ? 'dark' : (hostTheme ?? 'light dark');
  }

  async function loadAppearance(value?: string) {
    el('appearance').disabled = true;

    try {
      const result = await app.callServerTool({
        name: 'playlist_draft_appearance',
        arguments: value === undefined ? {} : { appearance: value },
      });
      const decoded = decodeDraftResult(result);
      const parsed = Appearance.safeParse(decoded.receipt.appearance);

      if (decoded.error || !parsed.success)
        throw new Error(decoded.error ?? 'Appearance unavailable.');

      appearance = parsed.data;
      host.dataset.palette = appearance;
      theme();
    } catch (error) {
      status(`Could not load or save appearance: ${errorMessage(error)}`, 'error');
    } finally {
      el('appearance').value = appearance;
      el('appearance').disabled = false;
    }
  }

  el('appearance').onchange = () => loadAppearance(el('appearance').value);

  function accept(data: DraftResponse) {
    const next = acceptDraftResponse(state, data, el('feedback').value);

    state = next.state;
    el('feedback').value = next.feedback;
    draftId = state.draft.draft_id;
    render();
  }

  function receive(decoded: ReturnType<typeof decodeDraftResult>, expectedId?: string) {
    // Accept valid receipts even when the operation failed. Never erase partial
    // write details merely because the host marked the result as an error.
    let acceptanceError: string | undefined;

    if (decoded.data?.draft) {
      try {
        if (expectedId && decoded.data.draft.draft_id !== expectedId)
          throw new Error('Response belongs to another draft. Use Reload latest.');

        accept(decoded.data);
      } catch (error) {
        acceptanceError = errorMessage(error);
      }
    }

    if (decoded.error || acceptanceError) {
      const { result, partial_write, saved_revision } = decoded.receipt;
      const details =
        result !== undefined || partial_write !== undefined || saved_revision !== undefined
          ? ` Receipt: ${JSON.stringify({ result, partial_write, saved_revision })}`
          : '';

      throw new Error([decoded.error, acceptanceError].filter(Boolean).join(' ') + details);
    }

    if (!decoded.data?.draft)
      throw new Error('Original draft data is unavailable. Recover using the draft ID.');

    return decoded.data;
  }

  function context() {
    if (!state) throw new Error('Recover a draft before continuing.');

    return draftContext(state);
  }

  async function publish() {
    try {
      await app.updateModelContext({
        content: [
          {
            type: 'text',
            text: `Selecta draft context (selection identifies the subject of feedback, not a requested change): ${JSON.stringify(context())}`,
          },
        ],
      });
    } catch {
      status(
        'Draft saved locally. Context delivery failed; use Send feedback or ask the agent to get this draft.',
        'error',
      );
    }
  }

  const lanes = { tempo: false, key: false };

  for (const lane of ['tempo', 'key'] as const)
    el(`timeline-${lane}`).onchange = () => {
      lanes[lane] = el(`timeline-${lane}`).checked;
      render();
    };

  function render() {
    if (!state) return;

    renderDraft(el, {
      ...state,
      inspection: state.inspection,
      inspection_error: state.inspection_error,
      busy,
      lanes,
      edit,
    });
  }

  async function action(fn: () => Promise<void>) {
    if (busy || !connected) return;

    // Nodes survive the render, so the inert editor can hand focus straight back.
    const focused = ui.activeElement;

    busy = true;
    render();

    try {
      await fn();
    } catch (error) {
      status(
        `${errorMessage(error)} No automatic retry. Use Reload latest to inspect current state.`,
        'error',
      );
    } finally {
      busy = false;
      render();
      (focused as HTMLElement | null)?.focus({ preventScroll: true });
    }
  }

  async function edit(
    patch: Partial<Pick<Draft, 'name' | 'entries' | 'selected_entry_ids' | 'feedback'>>,
  ) {
    patch = { feedback: el('feedback').value, ...patch };
    await action(async () => {
      if (!state || !draftId) return;

      receive(
        decodeDraftResult(
          await app.callServerTool({
            name: 'edit_playlist_draft',
            arguments: { draft_id: draftId, revision: state.draft.revision, ...patch },
          }),
        ),
        draftId,
      );
      status(`Draft revision ${state.draft.revision} saved locally.`, 'ok');
      await publish();
    });
  }

  async function recover(id?: string) {
    if (!id || !connected) return;

    await action(async () => {
      receive(
        decodeDraftResult(
          await app.callServerTool({ name: 'get_playlist_draft', arguments: { draft_id: id } }),
        ),
        id,
      );

      if (state) {
        const recovered = recoveredStatus(state.draft);

        status(recovered.text, recovered.tone);
      }
    });
  }

  el('feedback-toggle').onclick = () => {
    const panel = el('feedback-panel');

    panel.hidden = !panel.hidden;
    el('feedback-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    render();

    if (!panel.hidden) el('feedback').focus();
  };

  el('options').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      el('options').open = false;
      el('options').querySelector<HTMLElement>('summary')?.focus();
    }
  });
  ui.addEventListener('click', (event) => {
    if (!event.composedPath().includes(el('options'))) el('options').open = false;
  });

  el('recover').onclick = () => recover(el('recover-id').value.trim());
  el('reload').onclick = () => recover(draftId);
  el('keep-feedback').onclick = () => edit({ feedback: el('feedback').value });

  el('send').onclick = () => {
    const feedback = el('feedback').value;

    return action(async () => {
      if (!state || !draftId) return;

      if (feedback !== state.draft.feedback)
        receive(
          decodeDraftResult(
            await app.callServerTool({
              name: 'edit_playlist_draft',
              arguments: { draft_id: draftId, revision: state.draft.revision, feedback },
            }),
          ),
          draftId,
        );

      const delivery = await app.sendMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Please revise this Selecta draft using my explicit feedback. Selected entry IDs identify the tracks I am referring to; an empty selection means the whole playlist. Selection alone does not request replacement, removal or preservation: ${JSON.stringify(context())}`,
          },
        ],
      });

      if (delivery.isError)
        throw new Error(
          'The host rejected the feedback message. Your feedback remains in this draft; use Send feedback to try another explicit delivery.',
        );

      status('Feedback handed to the host. If it appears in the composer, press Send.', 'ok');
    });
  };

  el('save').onclick = () =>
    action(async () => {
      if (!state || !draftId) return;

      if (state.draft.save || state.inspection_error) return;

      const revision = state.draft.revision;

      status(`Saving revision ${revision} to Music.app…`, 'pending');
      const result = await app.callServerTool({
        name: 'save_playlist_draft',
        arguments: { draft_id: draftId, revision },
      });
      const data = receive(decodeDraftResult(result), draftId);
      const saved = recoveredStatus(state.draft);

      status(
        data.draft?.save
          ? saved.text
          : `Save outcome unknown. Inspect Music.app and reload the draft. ${JSON.stringify(data.result ?? {})}`,
        data.draft?.save ? saved.tone : 'pending',
      );
      await publish();
    });

  // Hosts may deliver tool input while show_playlist_draft is still running,
  // before the draft row exists. Recovery from the input alone only serves a
  // host that never delivers the result, so give the result a moment first.
  const RESULT_GRACE_MS = 1500;
  let resultFallback: ReturnType<typeof setTimeout> | undefined;

  app.ontoolinput = ({ arguments: args }) => {
    if (state || typeof args?.draft_id !== 'string') return;

    draftId = args.draft_id;
    el('recover-id').value = args.draft_id;
    clearTimeout(resultFallback);
    resultFallback = setTimeout(() => {
      if (!state && connected) void recover(draftId);
    }, RESULT_GRACE_MS);
  };

  app.ontoolresult = (result) => {
    clearTimeout(resultFallback);
    receivedResult = true;
    const decoded = decodeDraftResult(result);

    failedResult = !!decoded.error;

    try {
      receive(decoded);

      // A replayed result after reload can be stale; the store holds the latest.
      if (connected) void recover(draftId);
    } catch (error) {
      status(errorMessage(error), 'error');

      // A failed show created nothing to recover; a stripped result did.
      if (draftId && connected && !decoded.error) void recover(draftId);
    }
  };

  app.onhostcontextchanged = theme;

  async function connect() {
    try {
      await app.connect();
      connected = true;
      observeSize(host, (height) => {
        void app
          .sendSizeChanged({ height })
          .catch((error) => console.error('Card sizing failed', error));
      });
      theme(app.getHostContext());

      if (!state && !receivedResult)
        status('Ready. Recover a draft by ID if its original result is unavailable.');

      if (draftId && (!receivedResult || !failedResult)) await recover(draftId);

      await loadAppearance();
    } catch (error) {
      status(
        `Host connection failed: ${errorMessage(error)}. Reopen this card after reconnecting Selecta.`,
        'error',
      );
    }
  }

  return { connect, edit, recover };
}
