import type { z } from 'zod';
import { toErrorEnvelope as sharedErrorEnvelope, type SelectaError } from '../types/errors.js';

export function validationError(hint: string): SelectaError {
  return { error: 'validation_error', hint };
}

/** Shared zod parse → validation_error envelope, one format for every tool. */
export function parseInput<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; data: T } | { ok: false; error: SelectaError } {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      error: validationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      ),
    };
  }

  return { ok: true, data: parsed.data };
}

/** Convert a thrown BridgeError to the wire envelope; rethrow anything else. */
export function toErrorEnvelope(err: unknown): SelectaError {
  return sharedErrorEnvelope(err);
}

export function isSelectaError(value: object): value is SelectaError {
  return 'error' in value;
}
