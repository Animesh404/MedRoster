import { z } from 'zod'
import { mutationIdSchema, requirementsSchema } from './common'

/** Clinic-local wall clock, exactly as a manager types it. */
export const localDateTimeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
})

export const createShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  mutationId: mutationIdSchema,
  recurrence: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
})

/**
 * `expectedVersion` alone cannot guard a commit: `Shift.version` is bumped
 * only by another edit/delete, never by `assignClaim`/`unassignClaim` (see
 * `lib/rules/edit.ts`'s `EditPreview` doc comment), so a claim landing
 * between preview and confirm would otherwise slip past a version-only check
 * undetected — a manager could confirm a drop list that no longer matches
 * reality. `claimsToken` is the fingerprint of the claim set the preview was
 * computed against; `commitShiftEdit`/`commitShiftDelete` require both.
 */
export const updateShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  expectedVersion: z.number().int().min(0),
  claimsToken: z.string().min(1),
  mutationId: mutationIdSchema,
})

export const droppedClaimSchema = z.object({
  userId: z.number().int(),
  name: z.string(),
  // Null for the (rare, invalid-state) case of a professionless claimant —
  // mirrors `DroppedClaim.profession` in lib/rules/edit.ts.
  profession: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST']).nullable(),
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
  profession: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST']).nullable(),
})

export const deletePreviewSchema = z.object({
  version: z.number().int(),
  claimsToken: z.string(),
  holders: z.array(shiftHolderSchema),
})

export type CreateShiftBody = z.infer<typeof createShiftSchema>
export type UpdateShiftBody = z.infer<typeof updateShiftSchema>
export type EditPreviewResponse = z.infer<typeof editPreviewSchema>
export type DeletePreviewResponse = z.infer<typeof deletePreviewSchema>
