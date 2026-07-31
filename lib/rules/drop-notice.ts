import type { DropNotice, Prisma, PrismaClient } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'

export type DropKind = 'dropped' | 'deleted'

export interface DropNoticeInput {
  userId: number
  shiftId: number
  kind: DropKind
  reason: string
  /**
   * The dropped shift's own scheduled time, snapshotted.
   *
   * Not a join, deliberately: a deletion removes the `Shift` row, and the old
   * render-time code recovered its times by digging through that shift's event
   * history — which only worked for as long as those events survived. Recording
   * them here is what lets the outbox be pruned later.
   */
  shiftStartsAt: Date | null
  shiftEndsAt: Date | null
}

/**
 * Records that members lost shifts they were holding.
 *
 * ONE writer for every path that drops somebody — a shift edit that makes them
 * ineligible, a shift deletion, an offboarding. They previously agreed only by
 * each remembering to emit the right event, and the notice was reconstructed at
 * render time from those events. A fourth drop path that forgot would have
 * produced no notice at all, and nothing would have said so.
 *
 * Takes the caller's transaction, so the notice and the claim removal commit
 * together. A notice without the drop would be a lie; a drop without the notice
 * is the silence this whole feature exists to prevent.
 */
export async function recordDropNotices(
  tx: Prisma.TransactionClient,
  notices: DropNoticeInput[],
): Promise<void> {
  if (notices.length === 0) return
  await tx.dropNotice.createMany({ data: notices })
}


/**
 * The notices a member should currently see.
 *
 * Two ways a notice stops showing, and both matter:
 *
 *  - **Dismissed.** The acknowledgement. Without it, somebody dropped from a
 *    shift four weeks out stares at the same banner for four weeks.
 *  - **Expired.** So an unread notice cannot accumulate forever.
 *
 * Expiry is `shiftStartsAt + GRACE`, with a floor of `createdAt + GRACE` — NOT
 * simply "the shift has started". That earlier rule conflated acting with
 * knowing, and made a notice possible to be born invisible: deleting a shift
 * that started yesterday wrote a notice whose start time was already past, so
 * it was filtered out the instant it existed. Deleting one starting in ten
 * minutes gave the nurse ten minutes. The entire premise here is that somebody
 * must not discover this by turning up, so the notice has to outlive the shift
 * it is about.
 *
 * A notice whose `shiftStartsAt` is NULL falls back to the `createdAt` floor
 * rather than showing forever — it still gets a full grace period from when it
 * was written, which is the guarantee that matters, without becoming permanent.
 */
export const NOTICE_GRACE_MS = 48 * 60 * 60 * 1000

export async function activeDropNotices(
  db: PrismaClient,
  userId: number,
  opts: { now?: Date } = {},
): Promise<DropNotice[]> {
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - NOTICE_GRACE_MS)

  return db.dropNotice.findMany({
    where: {
      userId,
      dismissedAt: null,
      // Still within grace of the shift's start, OR still within grace of when
      // the notice was written. The second is what stops a notice for an
      // already-started (or timeless) shift being invisible on arrival.
      OR: [{ shiftStartsAt: { gt: cutoff } }, { createdAt: { gt: cutoff } }],
    },
    orderBy: { id: 'desc' },
    // A member with hundreds of outstanding notices has a different problem;
    // this stops one runaway case turning a page render into an unbounded read.
    take: 50,
  })
}

/**
 * Marks one of the member's own notices as acknowledged.
 *
 * Scoped by `userId` in the WHERE clause rather than checked after loading: the
 * id arrives from the client, and anyone could otherwise clear anyone else's
 * notice by guessing an integer. A miss is reported as NOT_FOUND rather than
 * FORBIDDEN, so the endpoint does not confirm which ids exist.
 */
export async function dismissDropNotice(
  db: PrismaClient,
  userId: number,
  noticeId: number,
  opts: { now?: Date } = {},
): Promise<{ ok: true } | AppError> {
  const now = opts.now ?? new Date()

  // `updateMany` with both keys, so ownership is part of the write rather than
  // a check that could drift from it. Already-dismissed rows are excluded so a
  // repeat call keeps the original timestamp — the acknowledgement happened
  // when it happened.
  const { count } = await db.dropNotice.updateMany({
    where: { id: noticeId, userId, dismissedAt: null },
    data: { dismissedAt: now },
  })

  if (count === 0) {
    // Either it does not exist, belongs to somebody else, or was already
    // dismissed. The last is a no-op success from the caller's point of view,
    // so distinguish it rather than reporting a spurious failure.
    const alreadyMine = await db.dropNotice.findFirst({
      where: { id: noticeId, userId },
      select: { id: true },
    })
    if (alreadyMine) return { ok: true }
    return createAppError('NOT_FOUND', 'That notice no longer exists.')
  }

  return { ok: true }
}
