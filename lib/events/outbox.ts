import type { Prisma } from '@prisma/client'
import type { EventType } from './topics'

export interface EmitInput {
  topic: string
  type: EventType
  payload: Record<string, unknown>
  mutationId?: string
}

/**
 * Appends to the outbox INSIDE the caller's transaction. A database trigger
 * turns the insert into a Realtime broadcast, so an event is emitted if and
 * only if the mutation commits (§7.1). Never call this outside a transaction.
 */
export async function emitEvent(tx: Prisma.TransactionClient, input: EmitInput): Promise<void> {
  await tx.eventOutbox.create({
    data: {
      topic: input.topic,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
      mutationId: input.mutationId ?? null,
    },
  })
}
