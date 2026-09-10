// Browser-safe persisted draft contract. Keep storage and host validation aligned.
import { z } from 'zod';

export const Appearance = z.enum(['host', 'copper', 'cobalt', 'ember', 'moss', 'oxblood', 'oled']);

export const Entry = z.strictObject({
  entry_id: z.string().uuid(),
  track_id: z.string().min(1),
});
export const Draft = z.strictObject({
  draft_id: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(300),
  entries: z.array(Entry).min(1).max(500),
  selected_entry_ids: z.array(z.string().uuid()).max(500),
  feedback: z.string().max(2000),
  save: z
    .strictObject({
      revision: z.number().int().positive(),
      status: z.enum(['pending', 'finished']),
      result: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type Draft = z.infer<typeof Draft>;

// Validate the fields consumed by the card, retaining other inspection facts
// and receipt fields for transport compatibility and future save lifecycles.
const count = z.number().int().nonnegative();
const record = z.record(z.string(), z.unknown());

export const DraftError = z.looseObject({ error: z.string(), hint: z.string().optional() });
export const DraftInspection = z.looseObject({
  track_count: count,
  tracks: z
    .array(
      z.looseObject({
        persistent_id: z.string().min(1),
        title: z.string().optional(),
        artist: z.string().optional(),
        duration_seconds: z.number().nonnegative().optional(),
        bpm: z.number().optional(),
        musical_key: z.string().optional(),
      }),
    )
    .max(500),
  runtime: z.looseObject({ known_seconds: z.number().nonnegative(), missing_count: count }),
  duplicate_ids: z.array(record),
  duplicate_owned_copies: z.array(record),
  artist_counts: z.array(z.looseObject({ artist: z.string(), count })),
  unknown_artist_count: count,
  feature_coverage: z.looseObject({ bpm: z.looseObject({ missing_count: count }) }),
});
export const DraftResponse = z.looseObject({
  draft: Draft.optional(),
  inspection: DraftInspection.optional(),
  inspection_error: DraftError.optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
  result: record.optional(),
  partial_write: record.optional(),
  saved_revision: count.positive().optional(),
});
export type DraftResponse = z.infer<typeof DraftResponse>;
export type DraftView = DraftResponse & { draft: Draft };

// Receipts remain open records. Only validated known outcome fields determine
// success; an unfamiliar or malformed outcome stays available for inspection.
export const DraftSaveOutcome = z.looseObject({
  error: z.string().optional(),
  hint: z.string().optional(),
  playlist_id: z.string().min(1).optional(),
  order_matches_request: z.boolean().optional(),
});
