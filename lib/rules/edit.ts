import type { PrismaClient, Prisma, Profession } from '@prisma/client'
import { createAppError, type AppError, type RuleCode } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from './assign'
import { withOrderedLocks } from './locks'
import { validateAssignment } from './validate'

export interface ProposedShift {
  startsAt: Date
  endsAt: Date
  requirements: Record<Profession, number>
}

export interface DroppedClaim {
  userId: number
  name: string
  profession: Profession
  code: RuleCode
  reason: string
}

export interface EditPreview {
  version: number
  kept: number[]
  dropped: DroppedClaim[]
}

const ZERO: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

/**
 * Re-runs the claim validator against the PROPOSED shift state and decides who
 * survives (§4.3). Shared verbatim by preview and commit — the preview is the
 * commit in dry-run mode, so the two can never disagree about who gets dropped.
 *
 * Claims are considered oldest-first, so when a requirement is lowered the most
 * recently made commitments are the ones dropped.
 */
async function computeSurvivors(
  tx: Prisma.TransactionClient,
  shiftId: number,
  proposed: ProposedShift,
  now: Date,
): Promise<EditPreview> {
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } })

  const claims = await tx.claim.findMany({
    where: { shiftId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true, profession: true } } },
  })

  const requirements = (Object.keys(proposed.requirements) as Profession[])
    .map((profession) => ({ profession, requiredCount: proposed.requirements[profession] }))

  const proposedShift = { id: shiftId, startsAt: proposed.startsAt, endsAt: proposed.endsAt, requirements }

  const running = { ...ZERO }
  const kept: number[] = []
  const dropped: DroppedClaim[] = []

  for (const claim of claims) {
    // The holder's OTHER shifts, so a retimed shift can be detected as overlapping.
    const others = await tx.claim.findMany({
      where: { userId: claim.userId, shiftId: { not: shiftId } },
      select: { shift: { select: { id: true, startsAt: true, endsAt: true } } },
    })

    const failure = validateAssignment(
      proposedShift,
      { id: claim.userId, profession: claim.user.profession },
      { claimsByProfession: running, userOtherShifts: others.map((o) => o.shift) },
      now,
    )

    if (failure) {
      dropped.push({
        userId: claim.userId,
        name: claim.user.name,
        profession: claim.user.profession!,
        code: failure.code,
        reason: failure.message,
      })
    } else {
      kept.push(claim.userId)
      if (claim.user.profession) running[claim.user.profession] += 1
    }
  }

  return { version: shift.version, kept, dropped }
}

/**
 * Read-only: runs inside its own transaction for a consistent snapshot, but the
 * transaction only ever reads, so nothing is written. A dry run cannot mutate.
 */
export async function previewShiftEdit(
  db: PrismaClient,
  shiftId: number,
  proposed: ProposedShift,
  now: Date = new Date(),
): Promise<EditPreview | AppError> {
  const exists = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true } })
  if (!exists) return createAppError('NOT_FOUND', 'That shift no longer exists.')

  return db.$transaction((tx) => computeSurvivors(tx, shiftId, proposed, now), TX_OPTIONS)
}

export async function commitShiftEdit(
  db: PrismaClient,
  shiftId: number,
  proposed: ProposedShift,
  expectedVersion: number,
  mutationId?: string,
  now: Date = new Date(),
): Promise<EditPreview | AppError> {
  return db.$transaction(async (tx) => {
    const claimants = await tx.claim.findMany({ where: { shiftId }, select: { userId: true } })

    return withOrderedLocks(
      tx,
      { shiftIds: [shiftId], userIds: claimants.map((c) => c.userId) },
      async () => {
        const shift = await tx.shift.findUnique({ where: { id: shiftId } })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

        // A claim landing between preview and confirm bumps the shift version
        // (via the concurrent commit's own increment), so checking it AND
        // re-computing under lock means the caller is shown the fresh result
        // rather than having a stale plan applied.
        if (shift.version !== expectedVersion) {
          return createAppError('VERSION_CONFLICT',
            'This shift changed while you were reviewing. Re-check the preview and try again.',
            { currentVersion: shift.version })
        }

        const outcome = await computeSurvivors(tx, shiftId, proposed, now)

        if (outcome.dropped.length > 0) {
          await tx.claim.deleteMany({
            where: { shiftId, userId: { in: outcome.dropped.map((d) => d.userId) } },
          })
        }

        const oldStartsAt = shift.startsAt

        await tx.shift.update({
          where: { id: shiftId },
          data: { startsAt: proposed.startsAt, endsAt: proposed.endsAt, version: { increment: 1 } },
        })

        for (const profession of Object.keys(proposed.requirements) as Profession[]) {
          const requiredCount = proposed.requirements[profession]
          await tx.shiftRequirement.upsert({
            where: { shiftId_profession: { shiftId, profession } },
            create: { shiftId, profession, requiredCount },
            update: { requiredCount },
          })
        }

        // Both weeks are notified when a shift moves across a week boundary.
        const topics = new Set([weekTopic(oldStartsAt), weekTopic(proposed.startsAt)])
        for (const topic of topics) {
          await emitEvent(tx, {
            topic, type: 'shift.edited',
            payload: { shiftId, startsAt: proposed.startsAt.toISOString(), endsAt: proposed.endsAt.toISOString() },
            ...(mutationId !== undefined ? { mutationId } : {}),
          })
          if (outcome.dropped.length > 0) {
            await emitEvent(tx, {
              topic, type: 'shift.claims_dropped',
              payload: { shiftId, dropped: outcome.dropped },
              ...(mutationId !== undefined ? { mutationId } : {}),
            })
          }
        }

        return { ...outcome, version: shift.version + 1 }
      },
    )
  }, TX_OPTIONS)
}

export async function previewShiftDelete(
  db: PrismaClient,
  shiftId: number,
): Promise<{ version: number; holders: DroppedClaim[] } | AppError> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    include: { claims: { include: { user: { select: { id: true, name: true, profession: true } } } } },
  })
  if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

  return {
    version: shift.version,
    holders: shift.claims.map((c) => ({
      userId: c.userId, name: c.user.name, profession: c.user.profession!,
      code: 'NOT_CLAIMED' as const, reason: 'Shift is being deleted.',
    })),
  }
}

export async function commitShiftDelete(
  db: PrismaClient,
  shiftId: number,
  expectedVersion: number,
  mutationId?: string,
): Promise<{ ok: true } | AppError> {
  return db.$transaction(async (tx) => {
    const claimants = await tx.claim.findMany({ where: { shiftId }, select: { userId: true } })

    return withOrderedLocks(tx, { shiftIds: [shiftId], userIds: claimants.map((c) => c.userId) }, async () => {
      const shift = await tx.shift.findUnique({ where: { id: shiftId } })
      if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')
      if (shift.version !== expectedVersion) {
        return createAppError('VERSION_CONFLICT',
          'This shift changed while you were reviewing. Re-check and try again.',
          { currentVersion: shift.version })
      }

      await emitEvent(tx, {
        topic: weekTopic(shift.startsAt),
        type: 'shift.deleted',
        payload: { shiftId, affectedUserIds: claimants.map((c) => c.userId) },
        ...(mutationId !== undefined ? { mutationId } : {}),
      })

      await tx.shift.delete({ where: { id: shiftId } }) // claims cascade

      return { ok: true as const }
    })
  }, TX_OPTIONS)
}
