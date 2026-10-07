// Screen switcher. Runs live here so a build keeps reporting while you're on
// another screen; each screen owns its own reads and edits.
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { selecta } from './api.js';
import { Brief } from './components/Brief.js';
import { Draft } from './components/Draft.js';
import { ExplainProvider } from './components/Explain.js';
import { Home } from './components/Home.js';
import { recoverRuns, rejectRun, runEvent, type Run } from './state.js';

type Screen = { name: 'home' } | { name: 'brief' } | { name: 'draft'; draftId: string };

function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [runs, setRuns] = useState<Record<string, Run>>({});

  // The host keeps every run's record, so a reload or a missed event catches up from it.
  const resync = useCallback(
    () =>
      selecta
        .call('agent.history')
        .then((history) => setRuns((current) => recoverRuns(current, history)))
        // A stopped host already surfaces through main's dialog and the screen's own read.
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    const unsubscribe = selecta.on((event) => {
      if (event.event !== 'agent') return;

      setRuns((current) => {
        const run = runEvent(current[event.draft_id], event.data, event.seq);

        if (!run) queueMicrotask(() => void resync());

        return run ? { ...current, [event.draft_id]: run } : current;
      });
    });

    void resync();

    return unsubscribe;
  }, [resync]);

  const ask = (draftId: string, text: string, call: Promise<unknown>) =>
    call.catch((e: Error) =>
      setRuns((current) => ({
        ...current,
        [draftId]: rejectRun(current[draftId], e.message, text),
      })),
    );

  const start = (draftId: string, brief: string) =>
    ask(draftId, brief, selecta.call('agent.start', { draft_id: draftId, brief }));

  if (screen.name === 'brief')
    return (
      <Brief
        onCancel={() => setScreen({ name: 'home' })}
        onStart={(brief) => {
          const draftId = crypto.randomUUID();

          void start(draftId, brief);
          setScreen({ name: 'draft', draftId });
        }}
      />
    );

  if (screen.name === 'draft') {
    const { draftId } = screen;

    return (
      <Draft
        key={draftId}
        draftId={draftId}
        run={runs[draftId]}
        onStart={(brief) => start(draftId, brief)}
        onSend={(text, message) =>
          ask(draftId, text, selecta.call('agent.send', { draft_id: draftId, message, text }))
        }
        onBack={() => setScreen({ name: 'home' })}
      />
    );
  }

  return (
    <Home
      runs={runs}
      onNew={() => setScreen({ name: 'brief' })}
      onOpen={(draftId) => setScreen({ name: 'draft', draftId })}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <ExplainProvider>
    <App />
  </ExplainProvider>,
);
