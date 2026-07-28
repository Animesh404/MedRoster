import { z } from 'zod'

export const PROFESSION = z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST'])

export const requirementsSchema = z.object({
  DOCTOR: z.number().int().min(0).max(50),
  NURSE: z.number().int().min(0).max(50),
  RECEPTIONIST: z.number().int().min(0).max(50),
}).refine((r) => r.DOCTOR + r.NURSE + r.RECEPTIONIST > 0, {
  message: 'A shift must require at least one person.',
})

export const pageQuerySchema = z.object({
  cursor: z.string().nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
})

/** Client-generated id used to suppress a caller's own realtime echo (§7.1). */
export const mutationIdSchema = z.string().min(8).max(64).optional()

export type Requirements = z.infer<typeof requirementsSchema>

const MAX_PG_INT = 2_147_483_647

/**
 * Strictly parses a route path segment as a valid Postgres `Int` id.
 *
 * `Number.isInteger(Number(raw))` (the pattern this replaces) is far looser
 * than it looks: it accepts out-of-Int32-range values (`2147483648`),
 * scientific notation (`1e21`), hex (`0x10`), padded/whitespace strings
 * (`' 1 '`), and even `''` (`Number('') === 0`, which is an integer). Every
 * one of those either 500s once it reaches Prisma or silently resolves to
 * the wrong row. Requiring the raw string to be nothing but ASCII digits,
 * then bounding it to Postgres's `Int` range, closes both holes.
 */
export function parseDbId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= MAX_PG_INT ? n : null
}
