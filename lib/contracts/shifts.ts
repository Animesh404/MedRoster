import { z } from 'zod'
import { mutationIdSchema, requirementsSchema, PROFESSION } from './common'

/**
 * A calendar date, shape- AND validity-checked.
 *
 * The regex alone accepts `2026-02-31` or `2026-99-99` — `Date.UTC` silently
 * overflow-normalises out-of-range components (Feb 31 becomes Mar 3, month
 * 99 becomes some date years away), so without the round-trip check below a
 * typo becomes a real roster entry with no error (IMP-1). Round-tripping
 * through `Date`'s UTC formatting and comparing against the original string
 * catches exactly that: a real date reproduces itself, an overflowed one
 * doesn't.
 */
export const isoDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .refine(
    (d) => {
      const dt = new Date(`${d}T00:00:00Z`)
      // A merely out-of-range component (e.g. day 31 of February) parses to
      // a valid (overflow-normalised) instant that the round-trip below
      // catches; a genuinely nonsense component (e.g. month 99) instead
      // parses to Invalid Date outright, and `.toISOString()` on that
      // THROWS rather than returning a string — checked separately so this
      // refine can reject it instead of crashing the request.
      return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d
    },
    'That date does not exist.',
  )

/** Clinic-local wall clock, exactly as a manager types it. */
export const localDateTimeSchema = z.object({
  date: isoDateSchema,
  startTime: z.string()
    .regex(/^\d{2}:\d{2}$/, 'Use HH:MM.')
    .refine((t) => {
      const [h, m] = t.split(':').map(Number)
      return h! <= 23 && m! <= 59
    }, 'Use a real time of day.'),
  endTime: z.string()
    .regex(/^\d{2}:\d{2}$/, 'Use HH:MM.')
    .refine((t) => {
      const [h, m] = t.split(':').map(Number)
      return h! <= 23 && m! <= 59
    }, 'Use a real time of day.'),
})

/** A recurrence may not run away to an arbitrarily distant `untilDate` — see
 *  MIN-5: unbounded, `occurrenceDates` silently clips at 366 rows with no
 *  signal to the caller. Bounding the schema to at most a year keeps the
 *  worst case within the cap so truncation should never legitimately fire;
 *  the route still checks for it defensively (belt and braces). */
const MAX_RECURRENCE_DAYS = 366

export const createShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  mutationId: mutationIdSchema,
  recurrence: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    untilDate: isoDateSchema,
  }).optional(),
}).superRefine((val, ctx) => {
  if (!val.recurrence) return
  const from = new Date(`${val.date}T00:00:00Z`)
  const until = new Date(`${val.recurrence.untilDate}T00:00:00Z`)
  const spanDays = (until.getTime() - from.getTime()) / 86_400_000
  if (spanDays < 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'untilDate must be on or after date.',
      path: ['recurrence', 'untilDate'],
    })
  } else if (spanDays > MAX_RECURRENCE_DAYS) {
    ctx.addIssue({
      code: 'custom',
      message: `A recurrence cannot span more than ${MAX_RECURRENCE_DAYS} days.`,
      path: ['recurrence', 'untilDate'],
    })
  }
})

/**
 * `expectedVersion` alone cannot guard a commit: `Shift.version` is bumped
 * only by another edit/delete, never by `assignClaim`/`unassignClaim` (see
 * `lib/rules/edit.ts`'s `EditPreview` doc comment), so a claim landing
 * between preview and confirm would otherwise slip past a version-only check
 * undetected — a manager could confirm a drop list that no longer matches
 * reality. `claimsToken` is the fingerprint of the claim set the preview was
 * computed against; `commitShiftEdit`/`commitShiftDelete` require both.
 *
 * Both are optional AT THE SCHEMA LEVEL (MIN-4): the `dryRun` path never
 * reads either, so requiring them here would force a client's first preview
 * request to invent placeholder values. The route's confirm branch is what
 * actually requires them, and rejects a confirm attempting to skip that.
 */
export const updateShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  expectedVersion: z.number().int().min(0).optional(),
  claimsToken: z.string().min(1).optional(),
  mutationId: mutationIdSchema,
})

export const droppedClaimSchema = z.object({
  userId: z.number().int(),
  name: z.string(),
  // Null for the (rare, invalid-state) case of a professionless claimant —
  // mirrors `DroppedClaim.profession` in lib/rules/edit.ts.
  profession: PROFESSION.nullable(),
  code: z.string(),
  reason: z.string(),
})

export const editPreviewSchema = z.object({
  version: z.number().int(),
  claimsToken: z.string(),
  kept: z.array(z.number().int()),
  dropped: z.array(droppedClaimSchema),
})

export const shiftHolderSchema = z.object({
  userId: z.number().int(),
  name: z.string(),
  profession: PROFESSION.nullable(),
})

export const deletePreviewSchema = z.object({
  version: z.number().int(),
  claimsToken: z.string(),
  holders: z.array(shiftHolderSchema),
})

/** The full shape `GET /api/shifts/:id` hands back (MIN-2): enforced, not
 *  aspirational, so a future `include`/`select` change that widens the
 *  fields Prisma returns can't silently widen the wire format too. */
export const shiftDetailSchema = z.object({
  id: z.number().int(),
  startsAt: z.date(),
  endsAt: z.date(),
  version: z.number().int(),
  seriesId: z.number().int().nullable(),
  detachedFromSeries: z.boolean(),
  requirements: z.array(z.object({
    id: z.number().int(),
    profession: PROFESSION,
    requiredCount: z.number().int(),
  })),
  claims: z.array(z.object({
    id: z.number().int(),
    userId: z.number().int(),
    assignedById: z.number().int().nullable(),
    createdAt: z.date(),
    user: z.object({
      id: z.number().int(),
      name: z.string(),
      profession: PROFESSION.nullable(),
    }),
  })),
})

