// Where cached artwork lives and how the renderer names it. Shared by the host
// (writes), main (serves) and the renderer (asks), so no Node imports here.

export const ARTWORK_SCHEME = 'selecta-art';

// One renderer request; a draft holds at most 500 entries.
export const ARTWORK_GET_LIMIT = 200;

// Every served thumbnail is a JPEG named by its track's persistent ID, which
// is the whole allowlist main checks before touching the disk.
export const ARTWORK_FILE = /^[0-9A-F]{16}\.jpg$/;

export function artworkDir(home: string): string {
  return `${home}/Library/Caches/Selecta/artwork`;
}

export function artworkUrl(file: string): string {
  return `${ARTWORK_SCHEME}://thumb/${file}`;
}

/** The cached file a request names, or undefined for anything else. */
export function artworkFileFor(url: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const file = parsed.pathname.slice(1);

  if (
    parsed.protocol !== `${ARTWORK_SCHEME}:` ||
    parsed.host !== 'thumb' ||
    parsed.search !== '' ||
    !ARTWORK_FILE.test(file)
  )
    return undefined;

  return file;
}
