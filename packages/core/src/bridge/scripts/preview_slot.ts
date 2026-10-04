// The reserved preview slot, found by name: exactly one plain user playlist, or
// a sentinel the caller maps to an error. Shared by every script that acts on
// the preview without replacing it.
export const PREVIEW_SLOT = `
      const matches = Music.playlists.whose({ name: args.name })()
        .filter(function (pl) { return pl.name() === args.name; });
      if (matches.length === 0) return JSON.stringify({ playlistNotFound: true });
      // Fail closed: unknown classes and unreadable identity properties are not targets.
      // Like preview creation, a smart playlist sharing the name is not a slot.
      const slots = matches.filter(function (pl) {
        return String(pl.class()) === 'userPlaylist' && !pl.smart() &&
          String(pl.specialKind()).toLowerCase() === 'none';
      });
      if (slots.length === 0) return JSON.stringify({ notEditable: true });
      if (slots.length !== 1) return JSON.stringify({ ambiguousPreview: true });
      const pl = slots[0];
      const ids = pl.tracks.length > 0 ? pl.tracks.persistentID() : [];
      if (JSON.stringify(ids) !== JSON.stringify(args.expectedTrackIds)) {
        return JSON.stringify({ orderDrifted: true });
      }`;
