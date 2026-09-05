import { z } from 'zod';
const id = z.string().min(1);
export const mbSearch = z.object({
  recordings: z.array(
    z.object({
      id,
      score: z.number().min(0).max(100),
      length: z.number().nonnegative().nullable().optional(),
    }),
  ),
});
const bulk = <T extends z.ZodType>(schema: T) => z.record(id, z.record(z.string(), schema));
export const abLow = bulk(
  z.object({
    rhythm: z.object({ bpm: z.number().positive().optional() }).optional(),
    tonal: z
      .object({
        key_key: z.string().min(1).optional(),
        key_scale: z.enum(['major', 'minor']).optional(),
      })
      .optional(),
  }),
);
export const abHigh = bulk(
  z.object({
    highlevel: z
      .object({
        danceability: z
          .object({ all: z.object({ danceable: z.number().min(0).max(1).optional() }).optional() })
          .optional(),
      })
      .optional(),
  }),
);
const error = z.object({ error: z.object({ message: z.string().optional() }) });
export const dzSearch = z.union([
  error,
  z.object({
    data: z.array(
      z.object({ id: z.number().int().positive(), duration: z.number().nonnegative() }),
    ),
  }),
]);
export const dzTrack = z.union([error, z.object({ bpm: z.number().nonnegative() })]);
