// One same-song identity for every cache consumer. SQLite delegates to this
// function so search dedupe and ordered-draft inspection cannot drift.

const UNIT_SEPARATOR = '\u001f';

export const SONG_IDENTITY_SQL_FUNCTION = 'selecta_song_identity_key';

function normalizeIdentityPart(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

export function songIdentityKey(
  title: string | null,
  artist: string | null,
  persistentId: string,
): string {
  if (!title?.trim() || !artist?.trim()) return persistentId;
  return `${normalizeIdentityPart(title)}${UNIT_SEPARATOR}${normalizeIdentityPart(artist)}`;
}
