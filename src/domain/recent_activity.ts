// Bundled into the explorer widget; keep this module free of Node imports.
// The shared "recent" window for play-history surfaces (issue #31): the
// recent_plays sort lens and library_overview's recent_activity both look back
// this far, so "recent" means one thing everywhere the model sees it.
export const RECENT_WINDOW_DAYS = 30;

export function recentSinceIso(): string {
  return new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
}
