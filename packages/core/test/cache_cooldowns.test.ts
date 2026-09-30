import { expect, it } from 'vitest';
import { SelectaCache } from '../src/cache/index.js';

it('keeps cooldowns host-specific and only extends an existing deadline', () => {
  const cache = SelectaCache.open(':memory:');

  try {
    expect(cache.getSourceCooldown('musicbrainz.org')).toBeNull();
    cache.setSourceCooldown('musicbrainz.org', 1000);
    cache.setSourceCooldown('musicbrainz.org', 500);
    cache.setSourceCooldown('deezer.com', 2000);
    expect(cache.getSourceCooldown('musicbrainz.org')).toBe(1000);
    expect(cache.getSourceCooldown('deezer.com')).toBe(2000);
    cache.setSourceCooldown('musicbrainz.org', 3000);
    expect(cache.getSourceCooldown('musicbrainz.org')).toBe(3000);
    expect(cache.getSourceCooldown('deezer.com')).toBe(2000);
  } finally {
    cache.close();
  }
});
