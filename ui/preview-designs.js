// Preview-only layout comparisons. Move the real controls without remounting
// the app, so draft state, pending edits and typed feedback stay in place.
(() => {
  const designs = ['queue', 'sidecar', 'setlist'];
  let current = 'queue';
  let apply;
  const make = (tag, className) => {
    const node = document.createElement(tag);

    node.className = className;

    return node;
  };

  function mount() {
    const host = [...document.body.children].find((node) => node.shadowRoot);

    if (!host) return false;

    const ui = host.shadowRoot;
    const get = (id) => ui.getElementById(id);
    const content = get('selecta-content');

    if (!content) return false;

    const ids = [
      'name',
      'summary',
      'revision',
      'reload',
      'recovery',
      'editor',
      'tracks',
      'feedback',
      'selected-count',
      'keep-feedback',
      'send',
      'save',
      'status',
    ];
    const nodes = Object.fromEntries(ids.map((id) => [id, get(id)]));
    const appearance = get('appearance').closest('label');
    const inspection = ui.querySelector('.inspection');
    const queueHead = ui.querySelector('.queue-head');
    const feedbackLabel = ui.querySelector('label[for="feedback"]');
    const feedbackBox = ui.querySelector('.feedback-box');
    const footer = ui.querySelector('footer');
    const options = make('details', 'card-options');
    const trigger = make('summary', 'options-trigger');

    trigger.textContent = '•••';
    trigger.setAttribute('aria-label', 'Card options');
    trigger.title = 'Appearance, reload and track details';
    const menu = make('div', 'options-panel');

    menu.append(appearance, nodes.reload, inspection, nodes.revision);
    options.append(trigger, menu);
    const heading = make('div', 'draft-heading');

    heading.append(nodes.name, nodes.summary);
    const top = make('header', 'draft-top');

    top.append(heading, options);
    feedbackLabel.className = 'feedback-label';
    nodes.feedback.rows = 1;
    nodes.feedback.placeholder = 'Give the agent a direction…';
    nodes['keep-feedback'].textContent = 'Keep';
    nodes['keep-feedback'].title = 'Keep feedback in this draft without sending';
    nodes.save.title = 'Save this revision as a new playlist in Music.app';
    const actions = make('div', 'compact-actions');
    const queuePanel = make('section', 'queue-panel');
    const composerPanel = make('aside', 'composer-panel');
    const toggle = make('button', 'compose-toggle');

    toggle.type = 'button';
    toggle.textContent = 'Give direction';
    toggle.setAttribute('aria-expanded', 'false');

    toggle.onclick = () => {
      feedbackBox.hidden = !feedbackBox.hidden;
      toggle.setAttribute('aria-expanded', String(!feedbackBox.hidden));

      if (!feedbackBox.hidden) nodes.feedback.focus();
    };

    options.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        options.open = false;
        trigger.focus();
      }
    });
    ui.addEventListener('click', (event) => {
      if (!event.composedPath().includes(options)) options.open = false;
    });

    const report = () => {
      const total = content.getBoundingClientRect().height;
      const queueHeight = nodes.tracks.getBoundingClientRect().height;

      parent.postMessage(
        {
          type: 'selecta-preview-space',
          design: current,
          queueHeight: Math.round(queueHeight),
          total: Math.round(total),
          share: total ? Math.round((queueHeight / total) * 100) : 0,
        },
        location.origin,
      );
    };
    const observer = new ResizeObserver(report);

    observer.observe(content);
    observer.observe(nodes.tracks);

    apply = (design) => {
      current = design;
      content.dataset.design = design;
      options.open = false;
      feedbackBox.hidden = false;
      actions.replaceChildren(nodes['keep-feedback'], nodes.send);
      feedbackBox.replaceChildren(feedbackLabel, nodes.feedback);
      footer.replaceChildren(nodes['selected-count'], actions, nodes.save);

      if (design === 'sidecar') {
        queuePanel.replaceChildren(queueHead, nodes.tracks);
        composerPanel.replaceChildren(nodes['selected-count'], feedbackBox, footer);
        footer.replaceChildren(actions, nodes.save);
        nodes.editor.replaceChildren(queuePanel, composerPanel);
      } else {
        if (design === 'setlist') {
          feedbackBox.append(actions);
          footer.replaceChildren(nodes['selected-count'], toggle, nodes.save);
          feedbackBox.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
        }

        nodes.editor.replaceChildren(queueHead, nodes.tracks, feedbackBox, footer);
      }

      content.replaceChildren(top, nodes.recovery, nodes.editor, nodes.status);
      requestAnimationFrame(report);
    };

    apply(current);

    return true;
  }

  addEventListener('message', ({ source, origin, data }) => {
    if (
      source !== parent ||
      origin !== location.origin ||
      data?.type !== 'selecta-preview-design' ||
      !designs.includes(data.design)
    )
      return;

    current = data.design;
    apply?.(current);
  });

  if (!mount()) {
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });

    observer.observe(document.body, { childList: true });
  }
})();
