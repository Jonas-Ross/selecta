// What the user tuned in Settings, kept per machine. A value that can't be read
// falls back to its default, so a stale or hand-edited store never breaks a screen.
import { CRATE_ORDERS, type CrateOrder } from '../shared/protocol.js';

const STORED = 'selecta.settings';

// AutoMix blends inside the last minute; past two there is nothing more to hear.
export const JOIN_LEAD = { min: 15, max: 120, step: 5, initial: 60 };
// Below this AutoMix may not have room to blend (from listening on the Mac).
export const JOIN_LEAD_TIGHT = 45;

export const MOTIONS = ['system', 'reduce'] as const;
export type Motion = (typeof MOTIONS)[number];

export type Settings = { joinLead: number; crateOrder: CrateOrder; motion: Motion };

export const DEFAULTS: Settings = {
  joinLead: JOIN_LEAD.initial,
  crateOrder: 'recently_added',
  motion: 'system',
};

export const CRATE_ORDER_LABELS: Record<CrateOrder, string> = {
  recently_added: 'Recently added',
  most_played: 'Most played',
  recent_plays: 'Played lately',
  least_played: 'Least played',
  random: 'Shuffled',
};

/** A join lead on the slider's own steps, inside its range. */
export function clampLead(value: number): number {
  if (!Number.isFinite(value)) return JOIN_LEAD.initial;

  const stepped = Math.round(value / JOIN_LEAD.step) * JOIN_LEAD.step;

  return Math.min(JOIN_LEAD.max, Math.max(JOIN_LEAD.min, stepped));
}

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback;

export function parseSettings(raw: unknown): Settings {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  return {
    joinLead: typeof value.joinLead === 'number' ? clampLead(value.joinLead) : DEFAULTS.joinLead,
    crateOrder: pick(CRATE_ORDERS, value.crateOrder, DEFAULTS.crateOrder),
    motion: pick(MOTIONS, value.motion, DEFAULTS.motion),
  };
}

export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(STORED) ?? '{}'));
  } catch {
    return DEFAULTS;
  }
}

export function storeSettings(settings: Settings) {
  try {
    localStorage.setItem(STORED, JSON.stringify(settings));
  } catch {
    // Locked storage keeps the change for this run only.
  }
}
