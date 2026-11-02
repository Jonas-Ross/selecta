// Notifications that float over the screen rather than push it down. One store for the
// whole app; a toast's key lets a later one replace it in place instead of piling up.
import { useEffect, useRef, useSyncExternalStore } from 'react';

export type Tone = 'success' | 'info' | 'warn' | 'error';

export interface ToastInput {
  text: string;
  tone?: Tone;
  /** A later toast with the same key replaces this one; by default, the same words do. */
  key?: string;
  /** The system's own words, shown small after the plain ones. */
  code?: string;
  action?: { label: string; run: () => void };
  /** Milliseconds on screen; null stays until dismissed. */
  ttl?: number | null;
  /** False for a toast that stands for a state only that state can clear. */
  dismissible?: boolean;
  /** Called when it is dismissed or times out; not when it is evicted or cleared. */
  onClose?: () => void;
}

export interface Toast extends ToastInput {
  id: number;
  key: string;
  tone: Tone;
  ttl: number | null;
  /** How many times the same text arrived under this key. */
  count: number;
  closing: boolean;
}

// Errors stay until read; anything with an action gets time to reach it.
const TTL: Record<Tone, number | null> = { success: 5000, info: 5000, warn: 8000, error: null };
const ACTION_TTL = 8000;
// Older toasts beyond this go, so a burst can't fill the screen.
const MAX = 4;
// Fallback for a leave transition that never reports its end.
const LEAVE_MS = 400;

export function createToasts() {
  let list: Toast[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const timers = new Map<
    number,
    { left: number; started: number; timer?: ReturnType<typeof setTimeout> }
  >();
  const pauses = new Set<string>();

  const emit = () => listeners.forEach((listener) => listener());

  function run(id: number) {
    const clock = timers.get(id);

    if (!clock || pauses.size) return;

    clock.started = Date.now();
    clock.timer = setTimeout(() => dismiss(id), clock.left);
  }

  function stop(id: number) {
    const clock = timers.get(id);

    if (clock?.timer === undefined) return;

    clearTimeout(clock.timer);
    clock.timer = undefined;
    clock.left = Math.max(0, clock.left - (Date.now() - clock.started));
  }

  function arm(toast: Toast) {
    stop(toast.id);
    timers.delete(toast.id);

    if (toast.ttl === null) return;

    timers.set(toast.id, { left: toast.ttl, started: Date.now() });
    run(toast.id);
  }

  const byKey = (key: string) => list.find((toast) => toast.key === key && !toast.closing);

  function show(input: ToastInput) {
    const tone = input.tone ?? 'info';
    const key = input.key ?? `${tone}:${input.text}`;
    const ttl = input.ttl !== undefined ? input.ttl : input.action ? ACTION_TTL : TTL[tone];
    const old = byKey(key);
    const count = old && old.text === input.text && old.tone === tone ? old.count + 1 : 1;
    const toast: Toast = { ...input, id: old?.id ?? next++, key, tone, ttl, count, closing: false };

    // Replaced in place, so the stack doesn't reshuffle; a fresh one goes on top.
    list = old ? list.map((other) => (other === old ? toast : other)) : [...list, toast];
    arm(toast);

    const open = list.filter((other) => !other.closing);

    if (open.length > MAX) {
      // Evicting isn't reading, so a toast that guards a state keeps its guard; those go last.
      const oldest =
        open.find((other) => other.ttl !== null) ??
        open.find((other) => other.dismissible !== false && !other.onClose) ??
        open.find((other) => other.dismissible !== false) ??
        open[0]!;

      close(oldest.id, false);
    }

    emit();
  }

  const dismiss = (id: number) => close(id, true);

  function close(id: number, answered: boolean) {
    const toast = list.find((other) => other.id === id);

    if (!toast || toast.closing) return;

    stop(id);
    timers.delete(id);
    list = list.map((other) => (other === toast ? { ...other, closing: true } : other));
    emit();

    if (answered) toast.onClose?.();

    setTimeout(() => remove(id), LEAVE_MS);
  }

  function remove(id: number) {
    if (!list.some((toast) => toast.id === id)) return;

    list = list.filter((toast) => toast.id !== id);
    emit();
  }

  return {
    show,
    dismiss,
    /** Takes down the toast under this key, if one is up. */
    clear: (key: string) => {
      const toast = byKey(key);

      if (toast) close(toast.id, false);
    },
    /** Every toast belongs to the screen it was raised on, so a screen that goes takes them. */
    clearAll: () => list.forEach((toast) => close(toast.id, false)),
    /** Clocks stop while any reason holds, such as a pointer over the stack or the window away. */
    pause: (reason: string) => {
      if (pauses.has(reason)) return;

      pauses.add(reason);
      timers.forEach((_, id) => stop(id));
      emit();
    },
    resume: (reason: string) => {
      if (!pauses.delete(reason)) return;

      if (!pauses.size) timers.forEach((_, id) => run(id));

      emit();
    },
    paused: () => pauses.size > 0,
    list: () => list,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => void listeners.delete(listener);
    },
  };
}

export const toasts = createToasts();

// Clocks stop while the window is away (in Music, say), whichever screen is up.
if (typeof window !== 'undefined') {
  if (!document.hasFocus()) toasts.pause('away');

  addEventListener('blur', () => toasts.pause('away'));
  addEventListener('focus', () => toasts.resume('away'));
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(toasts.subscribe, toasts.list);
}

/**
 * Holds a toast up while `value` is set and takes it down once it clears. Dismissing it
 * calls `onClose`, which should clear `value`; nothing else does.
 */
export function useToastWhile<T>(
  key: string,
  value: T | false | undefined,
  make: (value: T) => Omit<ToastInput, 'key' | 'onClose'>,
  onClose?: () => void,
) {
  const latest = useRef({ make, onClose });

  latest.current = { make, onClose };

  useEffect(() => {
    if (!value) return toasts.clear(key);

    toasts.show({ ...latest.current.make(value), key, onClose: () => latest.current.onClose?.() });
  }, [key, value]);
}
