import { z } from 'zod'
import { mutationIdSchema } from './common'

export const createClaimSchema = z.object({
  /** Omitted means "claim for myself"; managers may name another user. */
  userId: z.number().int().positive().optional(),
  mutationId: mutationIdSchema,
})

export const claimResultSchema = z.object({ claimId: z.number().int() })

export type CreateClaimBody = z.infer<typeof createClaimSchema>
