// The app window's Dig and Listen switch, like the app's own.
import { $$ } from './dom.js';

export function initDesk() {
  const buttons = $$('.views button');

  buttons.forEach((button) =>
    button.addEventListener('click', () => {
      const view = button.dataset.view;

      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      $$('.screen').forEach((img) => img.classList.toggle('on', img.dataset.view === view));
    }),
  );
}
