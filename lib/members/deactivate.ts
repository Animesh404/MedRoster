import type { PrismaClient } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from '@/lib/rules/assign'
import { withOrderedLocks } from '@/lib/rules/locks'

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

  // Ordinary (sequential) re-invocation short-circuits here, before the ban
  // call — a repeat deactivation of someone already marked has nothing left
  // to do, and skipping the network round-trip avoids re-banning an already-
  // banned account. This is not the concurrency guard (see below); it only
  // covers the common case where the caller already knows the outcome.
  if (profile.deactivatedAt) return { releasedShiftIds: [] }

  if (profile.authUserId) {
    const { error } = await admin.updateUserById(profile.authUserId, { ban_duration: BAN_FOREVER })
    if (error) return createAppError('INVALID_INPUT', 'Could not revoke that account’s access.')
  }

  return db.$transaction(
    (tx) =>
      // Only the user id is locked, not any shift id. The race being closed
      // is two deactivations of the SAME member, which locking that one user
      // id fully serialises. Locking shifts too would need their ids, which
      // aren't known until after the query below runs — and it would be
      // unnecessary anyway: deactivation only ever DELETES claims, so it
      // frees slots and can never oversell one, meaning it cannot violate the
      // invariant `assignClaim`'s shift lock protects. It also can't deadlock
      // against `assignClaim`: that path locks shift-then-user, this path
      // locks only a user and takes no further advisory lock, so there's no
      // cycle.
      withOrderedLocks(tx, { userIds: [userId] }, async () => {
        // Re-read inside the lock. The lock is the guard — it forces a
        // second concurrent caller to wait until the first has committed —
        // and this read is what observes the winner's committed effect. A
        // plain re-read alone (no lock) does NOT provide this: under READ
        // COMMITTED a SELECT takes no lock, so two overlapping transactions
        // can both read `deactivatedAt: null` before either writes, both
        // pass this check, and both compute and act on the same doomed
        // claims — see tests/concurrency/deactivate.test.ts, which fails
        // without `withOrderedLocks` and passes with it.
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
      }),
    TX_OPTIONS,
  )
}

/**
 * Brings a deactivated member back: clears the profile flag and lifts the
 * Supabase ban.
 *
 * **Deliberately asymmetric with `deactivateMember`.** That function released
 * the member's future claims; this one does NOT restore them. Someone else may
 * have picked those shifts up in the intervening days, and handing them back
 * would silently oversell the shift and countermand a colleague's claim. The
 * member returns to the roster able to claim again — they do not return to the
 * rota they left. Nothing about staffing changes, so no outbox events are
 * emitted either.
 *
 * The unban runs BEFORE the profile write, for the same reason the ban runs
 * before the transaction in `deactivateMember`: it is a network call to another
 * service and cannot join the transaction. Ordering it first means a failure
 * leaves the member deactivated in both stores — visibly incomplete and safe to
 * retry. The reverse would report a member as active while they still cannot
 * sign in, which is the two stores disagreeing silently.
 */
export async function reactivateMember(
  db: PrismaClient,
  admin: BanAdminPort,
  userId: number,
): Promise<{ ok: true } | AppError> {
  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile) return createAppError('NOT_FOUND', 'That person is not on the roster.')

  // Already active: nothing to undo, and no reason to spend an admin call.
  if (!profile.deactivatedAt) return { ok: true }

  if (profile.authUserId) {
    // Supabase's documented way to lift a ban. `deactivateMember` bans for
    // 100 years rather than forever, precisely so this is a plain unban and
    // not a special case.
    const { error } = await admin.updateUserById(profile.authUserId, { ban_duration: 'none' })
    if (error) {
      return createAppError('INVALID_INPUT', 'Could not restore that account’s access.')
    }
  }

  // Same user lock `deactivateMember` takes, for the same reason. Without it,
  // this sequence loses a deactivation silently: two managers both click
  // Reactivate; the first completes; a Deactivate then runs end to end (ban,
  // claim release, flag); the second — still holding its stale pre-lock read —
  // unbans and clears the flag. The member is quietly back, ban lifted, while
  // the manager who deactivated them was told it worked.
  //
  // The re-read inside the lock is what actually observes the winner's commit;
  // the read above it is only an early-exit convenience.
  return db.$transaction(
    (tx) =>
      withOrderedLocks(tx, { userIds: [userId] }, async () => {
        const current = await tx.user.findUniqueOrThrow({ where: { id: userId } })
        if (!current.deactivatedAt) return { ok: true as const }

        await tx.user.update({ where: { id: userId }, data: { deactivatedAt: null } })
        return { ok: true as const }
      }),
    TX_OPTIONS,
  )
}
