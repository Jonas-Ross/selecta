import { expect, it, vi } from 'vitest';
import { timelineEntries, clockLabel, renderTimeline } from '../ui/timeline.js';

const entries = [
  { entry_id: 'first', track_id: 'repeat' },
  { entry_id: 'middle', track_id: 'other' },
  { entry_id: 'last', track_id: 'repeat' },
];
const tracks = [
  {
    title: 'Repeated',
    artist: 'Artist A',
    duration_seconds: 90.5,
    bpm: 80,
    musical_key: 'C minor',
  },
  { title: 'Middle', artist: 'Artist B', duration_seconds: 181, bpm: null, musical_key: null },
  {
    title: 'Repeated',
    artist: 'Artist A',
    duration_seconds: 90.5,
    bpm: 80,
    musical_key: 'C minor',
  },
];

it('keeps exact occurrence order and accumulates durations without per-track rounding', () => {
  const result = timelineEntries(entries, tracks);

  expect(result.map(({ entry_id, start, end }) => ({ entry_id, start, end }))).toEqual([
    { entry_id: 'first', start: 0, end: 90.5 },
    { entry_id: 'middle', start: 90.5, end: 271.5 },
    { entry_id: 'last', start: 271.5, end: 362 },
  ]);
  expect(clockLabel(result[1].start)).toBe('1:30.5');
  expect(clockLabel(61.05)).toBe('1:01.05');
  expect(clockLabel(60)).toBe('1:00');
  expect(clockLabel(0)).toBe('0:00');
  expect(clockLabel(3600)).toBe('60:00');
});

it('breaks the elapsed clock at missing durations without discarding later known durations', () => {
  const result = timelineEntries(entries, [
    tracks[0],
    { ...tracks[1], duration_seconds: null },
    tracks[2],
  ]);

  expect(result.map(({ start, end, seconds }) => ({ start, end, seconds }))).toEqual([
    { start: 0, end: 90.5, seconds: 90.5 },
    { start: 90.5, end: null, seconds: null },
    { start: null, end: null, seconds: 90.5 },
  ]);
  expect(result[1]).toMatchObject({ bpm: null, key: null });
  expect(clockLabel(result[2].start)).toBe('Unknown');
  expect(timelineEntries(entries)[0]).toMatchObject({
    title: 'Title unavailable',
    artist: 'Artist unknown',
    seconds: null,
  });
  expect(
    timelineEntries(entries)
      .slice(1)
      .every((entry) => entry.start === null),
  ).toBe(true);
  expect(timelineEntries([], [])).toEqual([]);
});

it('treats a known zero duration as zero rather than unknown', () => {
  const result = timelineEntries(entries, [
    tracks[0],
    { ...tracks[1], duration_seconds: 0 },
    tracks[2],
  ]);

  expect(result[1]).toMatchObject({ seconds: 0, start: 90.5, end: 90.5 });
  expect(result[2]).toMatchObject({ start: 90.5, end: 181 });
});

// Controlled DOM checks public button labels, selection identity and widths;
// the browser smoke covers layout, focus and the actual host protocol.
class Element {
  children: Element[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  textContent = '';
  className = '';
  disabled = false;
  title = '';
  onclick = () => {};
  ownerDocument = { createElement: () => new Element() };
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
}

it('selects only the requested repeated occurrence and preserves facts in accessible labels', () => {
  const container = new Element();
  const onSelect = vi.fn();

  renderTimeline(container, timelineEntries(entries, tracks), {
    selected: ['last'],
    disabled: false,
    onSelect,
  });
  const [first, middle, last] = container.children;

  expect(first.attributes['aria-pressed']).toBe('false');
  expect(last.attributes['aria-pressed']).toBe('true');
  expect(last.attributes['aria-label']).toContain('Entry 3: Repeated, Artist A.');
  expect(last.attributes['aria-label']).toContain('Tempo 80 BPM. Key C minor.');
  expect(middle.attributes['aria-label']).toContain('Tempo unknown. Key unknown.');
  expect(parseFloat(middle.style.flex) / parseFloat(first.style.flex)).toBe(2);
  expect(first.children[2].dataset.color).toBe(last.children[2].dataset.color);
  last.onclick();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('last');
  // Track names are text, never HTML interpreted from library metadata.
  const unsafe = '<img src=x onerror=alert(1)>';

  renderTimeline(container, timelineEntries(entries, [{ ...tracks[0], title: unsafe }]), {
    selected: [],
    disabled: true,
    onSelect,
  });
  expect(container.children[0].children[1].textContent).toContain(unsafe);
  expect(container.children.every((button) => button.disabled)).toBe(true);
  expect(container.children[1].className).toContain('duration-unknown');
  expect(container.children[2].attributes['aria-label']).toContain('Starts Unknown; ends Unknown.');
});

it('retains all 500 entries on a bounded scrolling canvas, including very short and unknown tracks', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ entry_id: `e-${i}`, track_id: 'repeat' }));
  const facts = many.map((_, i) => ({
    ...tracks[0],
    duration_seconds: i === 250 ? null : i === 499 ? 0.1 : 3600,
  }));
  const container = new Element();

  renderTimeline(container, timelineEntries(many, facts), {
    selected: ['e-499'],
    disabled: false,
    onSelect: () => {},
  });
  expect(container.children).toHaveLength(500);
  expect(parseFloat(container.style.width)).toBeLessThanOrEqual(32000);
  expect(container.children[250].className).toContain('duration-unknown');
  expect(container.children[499].dataset.focus).toBe('timeline-e-499');
  expect(container.children[499].attributes['aria-pressed']).toBe('true');
  expect(container.children[499].attributes['aria-label']).toContain(
    'Duration 0:00.1. Starts Unknown',
  );
  expect(parseFloat(container.children[499].style.flex)).toBe(0.1);
});
