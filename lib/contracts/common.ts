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
 * Postgres `bigint`'s upper bound — the sibling of `MAX_PG_INT` above, for
 * the `EventOutbox.id` column (a `bigint`, not an `Int`). Without this,
 * `eventsSinceQuerySchema`'s `id` field accepts a digit string of any
 * length; Prisma passes it straight through to `BigInt(...)`, and a value
 * beyond this bound throws `P2020` once it reaches the query engine — the
 * same class of "unbounded digit string reaches the database and 500s" bug
 * `parseDbId` and `decodeCursor` already guard against for `Int` columns.
 */
// `BigInt(...)` call, not a `9223372036854775807n` literal: this project's
// `tsconfig.json` targets ES2017, where BigInt literal syntax doesn't
// type-check even though the runtime (Node) supports it fine.
export const MAX_PG_BIGINT = BigInt('9223372036854775807')

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
