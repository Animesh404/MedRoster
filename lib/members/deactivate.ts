import type { PrismaClient } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from '@/lib/rules/assign'

/** The slice of `supabase.auth.admin` needed to revoke a session. */
export interface BanAdminPort {
  updateUserById(id: string, attrs: { ban_duration?: string }): Promise<{ error: unknown }>
}

/**
 * Supabase expects a Go duration string. `876000h` is 100 years — Supabase has
 * no "ban forever" value, and reactivation is a deliberate future feature
 * (unban + clear deactivatedAt) rather than something a clock should do.
 */
const BAN_FOREVER = '876000h'

export interface DeactivateResult {
  /** Shifts whose staffing changed, so the caller can report what reopened. */
  releasedShiftIds: number[]
}

/**
 * Offboards a member: revoke the session, mark the profile, release future
 * claims, and tell every open dashboard.
 *
 * The claim policy is a product decision recorded in DECISIONS.md — future
 * claims are released because a member who has left should stop appearing as
 * cover for shifts they will not work; past claims stay because they are
 * history and deleting them would rewrite who worked an already-finished shift.
 *
 * The ban happens BEFORE the transaction because `admin.updateUserById` is a
 * network call to another service and cannot join a Postgres transaction, so
 * one of the two orderings has to be chosen deliberately.
 *
 * Note what the choice is NOT about: a marked-but-unbanned member is already
 * locked out, because `currentSessionUser()` fails closed on `deactivatedAt`
 * on every request. The Supabase-level ban is defence in depth, not the lock.
 *
 * The real trade is which partial state is preferable if the process dies
 * between the two. Ban-first leaves a revoked account whose claims are still
 * held — visibly incomplete, and safe to re-run. Mark-first leaves the product
 * outcome fully achieved with only the redundant ban missing, which is
 * harmless but invisible, so nobody would ever retry it. Ban-first is chosen
 * for being the failure that announces itself.
 */
export async function deactivateMember(
  db: PrismaClient,
  admin: BanAdminPort,
  userId: number,
  opts: { now?: Date } = {},
): Promise<DeactivateResult | AppError> {
  const now = opts.now ?? new Date()

  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile) return createAppError('NOT_FOUND', 'That person is not on the roster.')

  if (profile.authUserId) {
    const { error } = await admin.updateUserById(profile.authUserId, { ban_duration: BAN_FOREVER })
    if (error) return createAppError('INVALID_INPUT', 'Could not revoke that account’s access.')
  }

  return db.$transaction(async (tx) => {
    // Re-read inside the transaction: a concurrent deactivation must not
    // release the same claims twice or overwrite the original timestamp.
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (current.deactivatedAt) return { releasedShiftIds: [] }

    const doomed = await tx.claim.findMany({
      where: { userId, shift: { startsAt: { gt: now } } },
      select: { shiftId: true, shift: { select: { startsAt: true } } },
    })

    await tx.user.update({ where: { id: userId }, data: { deactivatedAt: now } })

    if (doomed.length > 0) {
      await tx.claim.deleteMany({ where: { userId, shiftId: { in: doomed.map((c) => c.shiftId) } } })

      // MUST match `DroppedClaim` from lib/rules/edit.ts:17-24. Two live
      // consumers destructure it — app/(app)/shifts/[id]/page.tsx:87 renders
      // `${d.name} was dropped — ${d.reason}` into the activity feed, and
      // app/(app)/my-shifts/page.tsx:152 reads `d.reason` into the drop
      // notice. Emitting a bare `{ userId }` type-checks (the payload is Json)
      // and renders "undefined was dropped — undefined".
      const dropped = [{
        userId: current.id,
        name: current.name,
        profession: current.profession,
        code: 'NOT_CLAIMED' as const,
        reason: 'They were removed from the roster.',
      }]

      for (const claim of doomed) {
        await emitEvent(tx, {
          // The SHIFT's week, not today's. Subscribers listen per week
          // (`weekTopic`), so an event on the wrong topic is delivered to
          // nobody watching that shift.
          topic: weekTopic(claim.shift.startsAt),
          type: 'shift.claims_dropped',
          payload: { shiftId: claim.shiftId, dropped },
        })
      }
    }

    return { releasedShiftIds: doomed.map((c) => c.shiftId) }
  }, TX_OPTIONS)
}
