import type { ToolDeps } from './deps.js';

/** Round cache age for the wire — sub-minute precision is token noise. */
export function roundedCacheAge(deps: ToolDeps): number | null {
  const age = deps.cache().getCacheAgeHours();

  return age == null ? null : Math.round(age * 100) / 100;
}
