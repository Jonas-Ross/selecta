import type { ToolDeps } from './deps.js';

/** Round cache age for the wire — sub-minute precision is token noise. */
export function roundCacheAge(age: number | null): number | null {
  return age == null ? null : Math.round(age * 100) / 100;
}

/** Read freshness when a handler has not already captured it in a snapshot. */
export function roundedCacheAge(deps: ToolDeps): number | null {
  return roundCacheAge(deps.cache().getCacheAgeHours());
}
