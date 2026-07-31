import { Prisma, type PrismaClient, type Profession } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { withOrderedLocks } from './locks'
import { recordDropNotices } from './drop-notice'
import {
  findRecordedOutcome, mutationScope, recordOutcome, scopeMismatchError,
} from './idempotency'
import { isCapacityError, withRetry } from './retry'
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

/**
 * READ COMMITTED is load-bearing here, not incidental — see the comment on
 * `withOrderedLocks` in `./locks` for why a stronger isolation level silently
 * lets this same code oversell a shift.
 */
export const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  /**
   * How long a transaction may wait to START before Prisma gives up with
   * P2028. The default is 2s, which is not enough here and was measured, not
   * guessed: `withOrderedLocks` serialises every claimant of one shift behind
   * a single advisory lock, so with ~30ms of work per claimant a burst of 50
   * puts the last one ~1.5s deep — right at the default's edge. 200 concurrent
   * claims on idle hardware produced 12 P2028s (docs/KNOWN_ISSUES.md).
   *
   * 15s covers a realistic shift-drop burst. It is a ceiling, not a target:
   * anything that genuinely exhausts it is a capacity problem the caller
   * should hear about as BUSY, which `withRetry` + `toBusyError` now arrange.
   */
  maxWait: 15_000,
  /** Once started, the work itself is small; this only bounds a pathological stall. */
  timeout: 20_000,
}

/**
 * Converts an exhausted-capacity throw into a domain error.
 *
 * Anything else is rethrown untouched — a genuine bug must still reach
 * `withAuth`'s catch-all and be logged as a 500, rather than being quietly
 * relabelled as congestion.
 */
function toBusyError(err: unknown): AppError {
  if (!isCapacityError(err)) throw err
  return createAppError(
    'BUSY',
    'Too many people are claiming this shift at once. Please try again in a moment.',
  )
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
        // Replay check FIRST, and inside the lock. Outside it, two simultaneous
        // retries of one key both miss, both do the work, and the second dies
        // on the primary key — turning a benign retry into an error.
        const scope = mutationScope('claim', input.shiftId, input.userId, input.actorId)
        if (input.mutationId !== undefined) {
          const seen = await findRecordedOutcome<{ claimId: number } | AppError>(
            tx, input.mutationId, scope,
          )
          if (seen && 'mismatch' in seen) return scopeMismatchError()
          if (seen) return seen.replay
        }

        // The body's result is captured once and recorded once, rather than a
        // `recordOutcome` call beside every early return. There are five ways
        // out of the rules below; a missed one would silently make that
        // rejection non-idempotent, and nothing would fail to say so.
        const outcome = await (async (): Promise<{ claimId: number } | AppError> => {
        const shift = await tx.shift.findUnique({
          where: { id: input.shiftId },
          include: { requirements: true },
        })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

        const user = await tx.user.findUnique({ where: { id: input.userId } })
        if (!user) return createAppError('NOT_FOUND', 'That staff member no longer exists.')

        const isSelfClaim = input.actorId === user.id
        if (!isSelfClaim) {
          // A manager is assigning someone else — confirm the actor is real
          // before it lands in Claim.assignedById, otherwise a stale/bad
          // actorId would surface as an unhandled foreign-key failure.
          const actor = await tx.user.findUnique({
            where: { id: input.actorId },
            select: { id: true },
          })
          if (!actor) return createAppError('NOT_FOUND', 'The assigning manager no longer exists.')
        }

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
          select: { shift: { select: { id: true, startsAt: true, endsAt: true } } },
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
            assignedById: isSelfClaim ? null : input.actorId,
          },
        })

        // Holding the shift again makes any outstanding "you were removed from
        // this shift" notice a lie, so it is dismissed rather than left to sit
        // above a shift that is back in their list. Dismissed, not deleted: the
        // record that they WERE told stays intact.
        await tx.dropNotice.updateMany({
          where: { userId: user.id, shiftId: shift.id, dismissedAt: null },
          data: { dismissedAt: now },
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
        })()

        if (input.mutationId !== undefined) {
          await recordOutcome(tx, input.mutationId, scope, outcome)
        }
        return outcome
      }),
    TX_OPTIONS,
    ).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = err.meta?.target as string[] | string | undefined
        const hit = Array.isArray(target) ? target.join(',') : (target ?? '')

        // MutationOutcome's PK is keyed on mutationId, which the advisory lock
        // — keyed on (shift, user) — does NOT cover. Two concurrent requests
        // reusing one key for DIFFERENT requests therefore take different
        // locks, both miss the replay lookup, and the second collides here.
        // That is the same client bug `scopeMismatchError` describes, just
        // reached by a race instead of sequentially, so it gets the same
        // answer. Crucially it is NOT evidence of a lock regression, and must
        // not raise that alarm.
        if (hit.includes('mutationId')) return scopeMismatchError()

        // Claim(shiftId, userId) IS covered by the lock, so a hit here really
        // is unreachable-in-theory and worth a trace rather than a silent
        // conversion.
        console.warn(
          'assignClaim: Claim unique-constraint backstop fired — advisory lock may be ineffective',
          err.meta,
        )
        if (hit.includes('userId')) {
          return createAppError('ALREADY_CLAIMED', 'You already hold this shift.')
        }
        throw err
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        // Backstop for the same actor-existence race the proactive check above
        // covers — belt and braces rather than an unhandled 500.
        return createAppError('NOT_FOUND', 'The assigning manager no longer exists.')
      }
      throw err
    }),
  ).catch(toBusyError)
}

export interface UnassignInput {
  db: PrismaClient
  shiftId: number
  userId: number
  /**
   * Who performed the release, when known.
   *
   * This function serves BOTH self-release and a manager removing somebody, and
   * without it cannot tell them apart — which is how the manager path went for
   * a long time writing no drop notice at all, silently. Only a release
   * performed by somebody else earns a notice: telling a nurse they were
   * "removed" from a shift they gave up themselves would be worse than saying
   * nothing. Absent (the seeder, internal callers) is treated as self, because
   * guessing "somebody else" would spam a notice for every seeded release.
   */
  actorId?: number
  mutationId?: string
  now?: Date
}

export async function unassignClaim(input: UnassignInput): Promise<{ ok: true } | AppError> {
  const now = input.now ?? new Date()

  return withRetry(() =>
    input.db.$transaction(async (tx) =>
      withOrderedLocks(tx, { shiftIds: [input.shiftId], userIds: [input.userId] }, async () => {
        // Same replay-inside-the-lock rule as assignClaim, and the mirror-image
        // bug: without it, retrying a release that already succeeded answers
        // NOT_CLAIMED, and the optimistic UI rolls back to showing the person
        // still holding a shift they have given up.
        const scope = mutationScope('release', input.shiftId, input.userId)
        if (input.mutationId !== undefined) {
          const seen = await findRecordedOutcome<{ ok: true } | AppError>(
            tx, input.mutationId, scope,
          )
          if (seen && 'mismatch' in seen) return scopeMismatchError()
          if (seen) return seen.replay
        }

        const outcome = await (async (): Promise<{ ok: true } | AppError> => {
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

        // Somebody else took this off them — they need telling, and the
        // notice has to outlive the event. Same transaction as the delete, so
        // a drop without its notice cannot happen.
        if (input.actorId !== undefined && input.actorId !== input.userId) {
          await recordDropNotices(tx, [{
            userId: input.userId,
            shiftId: input.shiftId,
            kind: 'dropped',
            reason: 'A manager removed you from this shift.',
            shiftStartsAt: shift.startsAt,
            shiftEndsAt: shift.endsAt,
          }])
        }

        await emitEvent(tx, {
          topic: weekTopic(shift.startsAt),
          type: 'shift.unclaimed',
          payload: { shiftId: shift.id, userId: input.userId },
          ...(input.mutationId !== undefined ? { mutationId: input.mutationId } : {}),
        })

        return { ok: true as const }
        })()

        if (input.mutationId !== undefined) {
          await recordOutcome(tx, input.mutationId, scope, outcome)
        }
        return outcome
      }),
    TX_OPTIONS,
    ).catch((err: unknown) => {
      // Mirror of assignClaim's handler: a reused key racing against a
      // different request collides on MutationOutcome's PK. Without this the
      // same client bug surfaces here as an unhandled 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = err.meta?.target as string[] | string | undefined
        const hit = Array.isArray(target) ? target.join(',') : (target ?? '')
        if (hit.includes('mutationId')) return scopeMismatchError()
      }
      throw err
    }),
  ).catch(toBusyError)
}
