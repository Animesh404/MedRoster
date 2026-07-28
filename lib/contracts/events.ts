import { z } from 'zod'

export const eventsSinceQuerySchema = z.object({
  id: z.string().regex(/^\d+$/).default('0'),
  topic: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const outboxEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  mutationId: z.string().nullable(),
})

export type OutboxEvent = z.infer<typeof outboxEventSchema>
