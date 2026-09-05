import { z } from 'zod';
import { BridgeError } from './errors.js';

/** Diagnostics name the boundary and path, never echo the external payload. */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  value: unknown,
  source: string,
  code: 'jxa_error' | 'enrichment_error',
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const message = `${source}: invalid payload at ${issue.path.join('.') || '<root>'} (${issue.code}).`;
  throw new BridgeError(code, message, message);
}
