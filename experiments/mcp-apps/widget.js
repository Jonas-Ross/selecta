import { App } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
const payload = z.object({
  draft: z.string(),
  tracks: z.array(z.object({ id: z.string(), title: z.string(), artist: z.string() })),
});
const app = new App({ name: 'Selecta fixture picker', version: '0.0.1' }, {}, { autoResize: true });
let draft;
let ids = [];
const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('button')];

function theme(context) {
  document.documentElement.style.colorScheme = context?.theme ?? 'light dark';
  document.querySelector('#host').textContent = JSON.stringify({
    theme: context?.theme,
    displayMode: context?.displayMode,
    containerDimensions: context?.containerDimensions,
  });
}

app.onhostcontextchanged = theme;

app.ontoolresult = (result) => {
  try {
    const data = payload.parse(result.structuredContent);

    draft = data.draft;
    ids = [];
    document.querySelector('h2').textContent = `Fixture draft: ${draft}`;
    const list = document.querySelector('#tracks');

    list.replaceChildren();

    for (const track of data.tracks) {
      const label = document.createElement('label');
      const input = document.createElement('input');

      input.type = 'checkbox';

      input.onchange = () => {
        ids = [...list.querySelectorAll('input:checked')].map((i) => i.value);
      };

      input.value = track.id;
      label.append(
        input,
        document.createTextNode(`${track.title} — ${track.artist} (${track.id})`),
      );
      list.append(label);
    }

    buttons.forEach((b) => (b.disabled = false));
    status.textContent = 'Ready. Selection belongs to this draft only.';
  } catch (error) {
    status.textContent = `Invalid tool result: ${error.message}`;
    buttons.forEach((b) => (b.disabled = true));
  }
};

async function act(fn) {
  buttons.forEach((b) => (b.disabled = true));

  try {
    const result = await fn();

    status.textContent = JSON.stringify(result ?? { ok: true });
  } catch (error) {
    status.textContent = `Host/server error: ${error.message}`;
  } finally {
    buttons.forEach((b) => (b.disabled = !draft));
  }
}

const selection = () => ({ draft, ids: [...ids] });

document.querySelector('#send').onclick = () =>
  act(() =>
    app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `Fixture selection: ${JSON.stringify(selection())}` }],
    }),
  );
document.querySelector('#context').onclick = () =>
  act(() =>
    app.updateModelContext({
      content: [
        { type: 'text', text: `Fixture selection context: ${JSON.stringify(selection())}` },
      ],
    }),
  );

for (const [id, controlled_error] of [
  ['echo', false],
  ['error', true],
])
  document.querySelector(`#${id}`).onclick = () =>
    act(() =>
      app.callServerTool(
        { name: 'echo_fixture_selection', arguments: { ...selection(), controlled_error } },
        { timeout: 10000 },
      ),
    );

app
  .connect()
  .then(() => theme(app.getHostContext()))
  .catch((error) => {
    status.textContent = `Connection failed: ${error.message}`;
  });
