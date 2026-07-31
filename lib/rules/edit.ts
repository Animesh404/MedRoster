import type { PrismaClient, Prisma, Profession } from '@prisma/client'
import { createAppError, type AppError, type RuleCode } from '@/lib/domain/errors'
import { PROFESSIONS } from '@/lib/domain/profession'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from './assign'
import { withOrderedLocks } from './locks'
import { withRetry } from './retry'
import { recordDropNotices } from './drop-notice'
import { validateAssignment } from './validate'

export interface ProposedShift {
  startsAt: Date
  endsAt: Date
  requirements: Record<Profession, number>
}

export interface DroppedClaim {
  userId: number
  name: string
  /** Null for the (rare, invalid-state) case of a professionless claimant. */
  profession: Profession | null
  code: RuleCode
  reason: string
}

/** A current claimant of a shift about to be deleted — not a rule violation,
 *  so this deliberately does NOT reuse `DroppedClaim`'s `code`/`reason` shape
 *  (see MINOR-9: labelling a holder `NOT_CLAIMED` was semantically inverted). */
export interface ShiftHolder {
  userId: number
  name: string
  profession: Profession | null
}

export interface EditPreview {
  version: number
  /** Fingerprint of exactly which claims exist right now. Guards the commit
   *  alongside `version`, because `Shift.version` is bumped only by an edit or
   *  delete — never by `assignClaim`/`unassignClaim` — so a claim landing
   *  between preview and confirm is otherwise invisible to the version check
   *  alone (see CRITICAL-1 in the review). */
  claimsToken: string
  kept: number[]
  dropped: DroppedClaim[]
}

const ZERO: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

/** Deterministic fingerprint of a claim set, order-independent so it agrees
 *  regardless of what order the two reads (preview vs. commit) happen to get
 *  rows back in. Any claim created or removed changes it. */
function claimsFingerprint(claims: { id: number }[]): string {
  const ids = claims.map((c) => c.id).sort((a, b) => a - b)
  return `${ids.length}:${ids.join('.')}`
}

/** Rejects a proposed shift interval that is nonsensical or already in the
 *  past, before any DB work happens (MINOR-11). */
function validateProposedInterval(proposed: ProposedShift, now: Date): AppError | null {
  if (proposed.startsAt >= proposed.endsAt) {
    return createAppError('INVALID_INPUT', 'A shift must start before it ends.')
  }
  if (proposed.startsAt <= now) {
    return createAppError('INVALID_INPUT', 'A shift cannot be moved into the past.')
  }
  return null
}

/**
 * Re-runs the claim validator against the PROPOSED shift state and decides who
 * survives (§4.3). Shared verbatim by preview and commit — the preview is the
 * commit in dry-run mode, so the two can never disagree about who gets dropped.
 *
 * Claims are considered oldest-first (with id as a tiebreak, since `createdAt`
 * ties are otherwise resolved by unspecified heap order — see MINOR-3), so
 * when a requirement is lowered the most recently made commitments are the
 * ones dropped.
 *
 * Returns null if the shift no longer exists — callers map that to NOT_FOUND.
 */
async function computeSurvivors(
  tx: Prisma.TransactionClient,
  shiftId: number,
  proposed: ProposedShift,
  now: Date,
): Promise<EditPreview | null> {
  const shift = await tx.shift.findUnique({ where: { id: shiftId } })
  if (!shift) return null

  const claims = await tx.claim.findMany({
    where: { shiftId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { user: { select: { id: true, name: true, profession: true } } },
  })

  // Drive the requirement list from the canonical profession list, not from
  // whatever keys happen to be present on `proposed.requirements` — a caller
  // that omits a profession must still have it treated as "required: 0", not
  // silently skipped (MINOR-7).
  const requirements = PROFESSIONS.map((profession) => ({
    profession, requiredCount: proposed.requirements[profession] ?? 0,
  }))

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
        profession: claim.user.profession,
        code: failure.code,
        reason: failure.message,
      })
    } else {
      kept.push(claim.userId)
      if (claim.user.profession) running[claim.user.profession] += 1
    }
  }

  return { version: shift.version, claimsToken: claimsFingerprint(claims), kept, dropped }
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
  const invalid = validateProposedInterval(proposed, now)
  if (invalid) return invalid

  const result = await db.$transaction((tx) => computeSurvivors(tx, shiftId, proposed, now), TX_OPTIONS)
  return result ?? createAppError('NOT_FOUND', 'That shift no longer exists.')
}

export async function commitShiftEdit(
  db: PrismaClient,
  shiftId: number,
  proposed: ProposedShift,
  expected: { version: number; claimsToken: string },
  mutationId?: string,
  now: Date = new Date(),
): Promise<EditPreview | AppError> {
  const invalid = validateProposedInterval(proposed, now)
  if (invalid) return invalid

  return withRetry(() =>
    db.$transaction(async (tx) =>
      // The shift lock is taken FIRST, before anyone is read as a claimant.
      // Only once it is held can the claimant list be read safely: `assignClaim`
      // needs this exact lock to create a Claim, so once we hold it no new
      // claim on this shift can land underneath us. Reading claimants BEFORE
      // any lock (the original bug) let a claim commit in that gap — handing
      // its holder a shift retime whose user id the edit never locked, free to
      // double-book them elsewhere while the edit was still mid-flight and its
      // retime not yet visible to anyone else (see CRITICAL-2 in the review).
      withOrderedLocks(tx, { shiftIds: [shiftId] }, async () => {
        const claimants = await tx.claim.findMany({ where: { shiftId }, select: { id: true, userId: true } })

        return withOrderedLocks(tx, { userIds: claimants.map((c) => c.userId) }, async () => {
          const shift = await tx.shift.findUnique({ where: { id: shiftId } })
          if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

          // A confirm is only valid against the EXACT plan it was previewed
          // against: both the version counter (bumped only by another
          // edit/delete) AND the fingerprint of who currently holds the shift.
          // `assignClaim`/`unassignClaim` never touch `Shift.version`, so a
          // claim landing between preview and confirm would otherwise slip
          // past a version-only guard undetected — guarding on the claim
          // fingerprint too closes that gap.
          const currentToken = claimsFingerprint(claimants)
          if (shift.version !== expected.version || currentToken !== expected.claimsToken) {
            return createAppError('VERSION_CONFLICT',
              'This shift changed while you were reviewing. Re-check the preview and try again.',
              { currentVersion: shift.version })
          }

          const outcome = await computeSurvivors(tx, shiftId, proposed, now)
          if (!outcome) return createAppError('NOT_FOUND', 'That shift no longer exists.')

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

          for (const profession of PROFESSIONS) {
            const requiredCount = proposed.requirements[profession] ?? 0
            await tx.shiftRequirement.upsert({
              where: { shiftId_profession: { shiftId, profession } },
              create: { shiftId, profession, requiredCount },
              update: { requiredCount },
            })
          }

          // Both weeks are notified when a shift moves across a week boundary.
          // Both topics' rows are written with the SAME mutationId (there is
          // only one to spend per commit) — a consumer that dedupes on
          // mutationId alone will wrongly suppress one week's event as a
          // duplicate of the other's. Dedup MUST key on (topic, mutationId),
          // never mutationId in isolation (MINOR-10; the client consuming this
          // is task 19's).
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

          // Durable, per-member, and written in this same transaction. The
          // event above is for live clients; this is what a nurse who was
          // offline still sees when they next open the app.
          await recordDropNotices(tx, outcome.dropped.map((d) => ({
            userId: d.userId,
            shiftId,
            kind: 'dropped' as const,
            reason: d.reason,
            shiftStartsAt: proposed.startsAt,
            shiftEndsAt: proposed.endsAt,
          })))

          return { ...outcome, version: shift.version + 1 }
        })
      }),
    TX_OPTIONS),
  )
}

export async function previewShiftDelete(
  db: PrismaClient,
  shiftId: number,
): Promise<{ version: number; claimsToken: string; holders: ShiftHolder[] } | AppError> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    include: { claims: { include: { user: { select: { id: true, name: true, profession: true } } } } },
  })
  if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

  return {
    version: shift.version,
    claimsToken: claimsFingerprint(shift.claims),
    holders: shift.claims.map((c) => ({
      userId: c.userId, name: c.user.name, profession: c.user.profession,
    })),
  }
}

export async function commitShiftDelete(
  db: PrismaClient,
  shiftId: number,
  expected: { version: number; claimsToken: string },
  mutationId?: string,
): Promise<{ ok: true } | AppError> {
  return withRetry(() =>
    db.$transaction(async (tx) =>
      // Same shift-lock-first ordering as commitShiftEdit, and for the same
      // reason: read the claimant list only after the shift itself is locked,
      // so no concurrent claim can land unlocked in the gap (CRITICAL-2).
      withOrderedLocks(tx, { shiftIds: [shiftId] }, async () => {
        const claimants = await tx.claim.findMany({ where: { shiftId }, select: { id: true, userId: true } })

        return withOrderedLocks(tx, { userIds: claimants.map((c) => c.userId) }, async () => {
          const shift = await tx.shift.findUnique({ where: { id: shiftId } })
          if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

          const currentToken = claimsFingerprint(claimants)
          if (shift.version !== expected.version || currentToken !== expected.claimsToken) {
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

          // Snapshot the times BEFORE the row is deleted. Afterwards they are
          // only recoverable by digging through this shift's event history,
          // which is precisely the dependency this table removes.
          await recordDropNotices(tx, claimants.map((c) => ({
            userId: c.userId,
            shiftId,
            kind: 'deleted' as const,
            reason: 'A manager deleted this shift.',
            shiftStartsAt: shift.startsAt,
            shiftEndsAt: shift.endsAt,
          })))

          await tx.shift.delete({ where: { id: shiftId } }) // claims cascade

          return { ok: true as const }
        })
      }),
    TX_OPTIONS),
  )
}
