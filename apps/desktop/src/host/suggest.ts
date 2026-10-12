// Asking the agent for stand-ins for one record. It reads and searches, never
// edits: the picks come back as a line of JSON for the app to show, and the
// user decides whether one goes in.
import { z } from 'zod';
import { READ_TOOLS } from './providers.js';

export const SUGGEST_LIMIT = 4;

// Read-only, so a suggestion can run while the draft plays through Selecta Preview.
export const SUGGEST_TOOLS = [...READ_TOOLS, 'get_playlist_draft'];

export const SUGGEST_INSTRUCTIONS = `You suggest stand-ins for one record in a playlist draft in the Selecta desktop app. Read the draft with get_playlist_draft and the records around it with inspect_tracklist, then search the library with the selecta tools. Use only track IDs the tools return, and leave out tracks already in the draft. Weigh the brief, the user's request, and how each pick sits with the records either side in tempo and key. You can't change the draft; the user decides. End your reply with one line of JSON and nothing after it: {"picks":[{"track_id":"…","reason":"…"}]}, up to ${SUGGEST_LIMIT} picks, best first, each reason one short plain sentence.`;

export function suggestPrompt({
  draftId,
  position,
  count,
  trackId,
  title,
  artist,
  brief,
  ask,
  exclude = [],
}: {
  draftId: string;
  position: number;
  count: number;
  trackId: string;
  title?: string;
  artist?: string;
  brief?: string;
  ask?: string;
  exclude?: string[];
}): string {
  const record = `"${title ?? 'Untitled'}" by ${artist ?? 'an unknown artist'}`;

  return [
    `Draft ID: ${draftId}`,
    `Suggest up to ${SUGGEST_LIMIT} tracks to replace record ${position} of ${count}: ${record} (track ID ${trackId}).`,
    ...(brief ? [`The draft's brief:\n${brief}`] : []),
    ...(exclude.length ? [`Already suggested, leave these out: ${exclude.join(', ')}`] : []),
    ...(ask ? [`The user asks for:\n${ask}`] : []),
  ].join('\n\n');
}

const Picks = z.object({
  picks: z
    .array(z.object({ track_id: z.string().min(1).max(64), reason: z.string().max(400).catch('') }))
    .max(20),
});

export type RawPick = z.infer<typeof Picks>['picks'][number];

/** The last `{"picks": …}` object in a reply, or none; prose and code fences around it are fine. */
export function parsePicks(text: string): RawPick[] {
  const key = text.lastIndexOf('"picks"');
  const start = text.lastIndexOf('{', key);

  if (key < 0 || start < 0) return [];

  for (let end = text.lastIndexOf('}'); end > key; end = text.lastIndexOf('}', end - 1)) {
    try {
      const parsed = Picks.safeParse(JSON.parse(text.slice(start, end + 1)));

      if (parsed.success) return parsed.data.picks;
    } catch {
      // Not this closing brace; try the one before it.
    }
  }

  return [];
}
