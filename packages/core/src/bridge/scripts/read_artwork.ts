// Read-only: write each track's first artwork, as Music.app stores it, into a
// directory. JXA's own artwork reads give no usable bytes (docs/music-app.md,
// Artwork), so they come from AppleScript's `raw data` through NSAppleScript.

import { isAbsolute } from 'node:path';
import { ARTWORK_BATCH_LIMIT, TRACK_PERSISTENT_ID } from '../../types/bridge.js';
import { BridgeError } from '../../types/errors.js';
import { wrapJxaScript } from './wrap.js';

// Base64 of the leading signature bytes, so the script can sniff the format
// without reading raw bytes through the ObjC bridge.
const JPEG = Buffer.from([0xff, 0xd8, 0xff]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');

// AppleScript errors that mean nothing in the batch can succeed: no Automation
// permission, or Music.app not running. Rethrown so runJxa maps them.
const FATAL = [-1743, -600, -609];

// "Can't get object": the track has no artwork. Any other code is a failed read.
const NO_ARTWORK = -1728;

export function buildReadArtworkScript(args: { trackIds: string[]; dir: string }): string {
  if (args.trackIds.length > ARTWORK_BATCH_LIMIT)
    throw new BridgeError(
      'validation_error',
      `At most ${ARTWORK_BATCH_LIMIT} tracks per artwork read.`,
    );

  const bad = args.trackIds.filter((id) => !TRACK_PERSISTENT_ID.test(id));

  if (bad.length > 0)
    throw new BridgeError('validation_error', `Not track persistent IDs: ${bad.join(', ')}`);

  if (!isAbsolute(args.dir))
    throw new BridgeError('validation_error', 'Artwork directory must be an absolute path.');

  return wrapJxaScript(
    args,
    `
    // Checked first so a read never launches Music.app; NSAppleScript's tell would.
    if (!Music.running()) throw new Error("Music.app isn't running. (-600)");
    ObjC.import('Foundation');
    const fatal = ${JSON.stringify(FATAL)};
    const written = {};
    for (const id of args.trackIds) {
      written[id] = null;
      const src = 'tell application "Music" to get raw data of artwork 1 of ' +
        '(first track of library playlist 1 whose persistent ID is "' + id + '")';
      const err = $();
      let res;
      try {
        res = $.NSAppleScript.alloc.initWithSource(src).executeAndReturnError(err);
      } catch (e) {}
      if (!res || res.isNil()) {
        let code = 0;
        try { code = ObjC.deepUnwrap(err).NSAppleScriptErrorNumber; } catch (e) {}
        if (fatal.indexOf(code) !== -1) throw new Error('Music.app artwork read failed (' + code + ')');
        if (code !== ${NO_ARTWORK}) written[id] = { error: code };
        continue;
      }
      const data = res.data;
      let ext = null;
      try {
        const head = data.length < 6 ? ''
          : data.subdataWithRange($.NSMakeRange(0, 6)).base64EncodedStringWithOptions(0).js;
        ext = head.indexOf(${JSON.stringify(JPEG)}) === 0 ? 'jpg'
          : head === ${JSON.stringify(PNG)} ? 'png' : null;
      } catch (e) {}
      if (ext === null) continue;
      const name = id + '.' + ext;
      // A full or unwritable directory fails the batch; it is not a track without art.
      if (!data.writeToFileAtomically(args.dir + '/' + name, true))
        throw new Error('Cannot write artwork into ' + args.dir);
      written[id] = name;
    }
    return JSON.stringify(written);
  `,
  );
}
