import { z } from 'zod'
import { MAX_PG_BIGINT } from './common'

export const eventsSinceQuerySchema = z.object({
  // The regex alone only bounds shape, not magnitude — a digit string with
  // no upper bound (e.g. a forged `?id=99999999999999999999999999`) passes
  // it, then blows up `BigInt(...)` against Postgres's `bigint` range with
  // an uncaught `P2020` once it reaches Prisma (500, mirroring the `Int`-id
  // bug `parseDbId`/`decodeCursor` already guard against). This zod version
  // runs a `.refine` even when an earlier `.regex` on the same schema has
  // already failed, so `BigInt(v)` cannot assume `v` is digits-only here —
  // re-checking the shape and catching keeps a non-numeric `id` (e.g. `abc`)
  // a single clean zod issue instead of an uncaught `SyntaxError`.
  id: z.string().regex(/^\d+$/).default('0')
    .refine((v) => {
      if (!/^\d+$/.test(v)) return true // already flagged by the .regex check above
      try {
        return BigInt(v) <= MAX_PG_BIGINT
      } catch {
        return false
      }
    }, { message: 'id is out of range.' }),
  topic: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const outboxEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  mutationId: z.string().nullable(),
  /** Optional so the reducer test literals (Task 19) that omit it stay valid —
   *  callers that only need reconciliation never look at this; the shift
   *  detail page's Activity timeline is the one consumer that does. */
  createdAt: z.string().optional(),
})

export type OutboxEvent = z.infer<typeof outboxEventSchema>
