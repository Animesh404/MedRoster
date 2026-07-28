import { Prisma, type PrismaClient, type Profession } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { withOrderedLocks } from './locks'
import { validateAssignment, type ClaimContext } from './validate'

export interface AssignInput {
  db: PrismaClient
  shiftId: number
  userId: number
  /** Who performed the action — the claimant themselves, or a manager. */
  actorId: number
  mutationId?: string
  now?: Date
}

const ZERO: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

/** Retries a transaction on serialization failure and deadlock (§4.2). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as { code?: string }).code
      // 40001 serialization_failure, 40P01 deadlock_detected
      if (code !== '40001' && code !== '40P01') throw err
      lastError = err
      await new Promise((r) => setTimeout(r, 10 * (i + 1) + Math.floor(Math.random() * 10)))
    }
  }
  throw lastError
}

/**
 * The ONLY function in the codebase that creates a Claim (§4.1). Staff claims,
 * manager assignments and the seeder all land here, which is what makes the
 * business rules hold for every path by construction rather than by discipline.
 */
export async function assignClaim(
  input: AssignInput,
): Promise<{ claimId: number } | AppError> {
  const now = input.now ?? new Date()

  return withRetry(() =>
    input.db.$transaction(async (tx) =>
      withOrderedLocks(tx, { shiftIds: [input.shiftId], userIds: [input.userId] }, async () => {
        const shift = await tx.shift.findUnique({
          where: { id: input.shiftId },
          include: { requirements: true },
        })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

        const user = await tx.user.findUnique({ where: { id: input.userId } })
        if (!user) return createAppError('NOT_FOUND', 'That staff member no longer exists.')

        const existing = await tx.claim.findUnique({
          where: { shiftId_userId: { shiftId: shift.id, userId: user.id } },
        })
        if (existing) return createAppError('ALREADY_CLAIMED', 'You already hold this shift.')

        // Counts and the user's other shifts are read INSIDE the lock, so the
        // validator sees a state no concurrent claim can be mutating.
        const grouped = await tx.claim.findMany({
          where: { shiftId: shift.id },
          select: { user: { select: { profession: true } } },
        })
        const claimsByProfession = { ...ZERO }
        for (const c of grouped) {
          if (c.user.profession) claimsByProfession[c.user.profession] += 1
        }

        const otherClaims = await tx.claim.findMany({
          where: { userId: user.id, shiftId: { not: shift.id } },
          select: { shift: { select: { startsAt: true, endsAt: true } } },
        })

        const ctx: ClaimContext = {
          claimsByProfession,
          userOtherShifts: otherClaims.map((c) => c.shift),
        }

        const failure = validateAssignment(shift, user, ctx, now)
        if (failure) return failure

        const claim = await tx.claim.create({
          data: {
            shiftId: shift.id,
            userId: user.id,
            assignedById: input.actorId === user.id ? null : input.actorId,
          },
        })

        await emitEvent(tx, {
          topic: weekTopic(shift.startsAt),
          type: 'shift.claimed',
          payload: {
            shiftId: shift.id, userId: user.id,
            profession: user.profession, name: user.name,
          },
          ...(input.mutationId !== undefined ? { mutationId: input.mutationId } : {}),
        })

        return { claimId: claim.id }
      }),
    ).catch((err: unknown) => {
      // The unique constraint is the last line of defence behind the lock.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return createAppError('ALREADY_CLAIMED', 'You already hold this shift.')
      }
      throw err
    }),
  )
}

export interface UnassignInput {
  db: PrismaClient
  shiftId: number
  userId: number
  mutationId?: string
  now?: Date
}

export async function unassignClaim(input: UnassignInput): Promise<{ ok: true } | AppError> {
  const now = input.now ?? new Date()

  return withRetry(() =>
    input.db.$transaction(async (tx) =>
      withOrderedLocks(tx, { shiftIds: [input.shiftId], userIds: [input.userId] }, async () => {
        const shift = await tx.shift.findUnique({ where: { id: input.shiftId } })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')
        if (shift.startsAt <= now) {
          return createAppError('SHIFT_IN_PAST', 'This shift has already started and cannot be changed.')
        }

        const claim = await tx.claim.findUnique({
          where: { shiftId_userId: { shiftId: input.shiftId, userId: input.userId } },
        })
        if (!claim) return createAppError('NOT_CLAIMED', 'That person does not hold this shift.')

        await tx.claim.delete({ where: { id: claim.id } })

        await emitEvent(tx, {
          topic: weekTopic(shift.startsAt),
          type: 'shift.unclaimed',
          payload: { shiftId: shift.id, userId: input.userId },
          ...(input.mutationId !== undefined ? { mutationId: input.mutationId } : {}),
        })

        return { ok: true as const }
      }),
    ),
  )
}
