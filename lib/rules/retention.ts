import type { PrismaClient } from '@prisma/client'
import { NOTICE_GRACE_MS } from './drop-notice'
import { TX_OPTIONS } from './assign'

/**
 * How long an idempotency record is kept.
 *
 * The window only has to outlast a retry that could plausibly still arrive.
 * `useOptimisticClaim` retries once, immediately, on a transport failure, and
 * the realtime echo-suppression TTL is 60 seconds — so the real requirement is
 * minutes. 24 hours is deliberately far beyond that: the cost of keeping a row
 * too long is a few bytes, and the cost of dropping one too early is the bug
 * idempotency exists to fix (the replay is gone, the rules re-run, and a nurse
 * is told ALREADY_CLAIMED for an action that succeeded).
 *
 * Asymmetric consequences, so err long.
 */
export const MUTATION_RETENTION_MS = 24 * 60 * 60 * 1000

/** Rows per DELETE. Small enough that no single statement holds a long lock. */
const DEFAULT_BATCH_SIZE = 500

/**
 * Ceiling on batches per run. A run that hits it simply leaves the rest for the
 * next one — a scheduled job should yield rather than grind, and an unbounded
 * loop against a runaway table is how a cleanup job becomes the outage.
 */
const DEFAULT_MAX_BATCHES = 20

export interface PruneOptions {
  /** Pinned "now", for deterministic tests. */
  now?: Date
  batchSize?: number
  maxBatches?: number
}

/**
 * Deletes expired `MutationOutcome` rows.
 *
 * Batched rather than one big DELETE: a backlog would otherwise hold a single
 * transaction open across many thousands of rows.
 *
 * It will not contend with live claiming at this schedule and scale — which is
 * a weaker and more honest claim than "cannot". At the row level it genuinely
 * cannot: a claim in flight writes `createdAt = now`, which the expiry
 * predicate never matches, and the pruner takes no advisory lock, so it never
 * joins the queue `withOrderedLocks` manages. But it shares the connection pool
 * that `lib/db/client.ts` identifies as what turns a claim burst into
 * P2024/P2028, and a run spends up to `maxBatches` statements against that
 * budget. At 03:00 and clinic scale that is nothing; at a different hour or a
 * different size it is not automatically nothing.
 *
 * One more hidden dependency worth stating: `cutoff` comes from the Node clock
 * while `createdAt` comes from Postgres. The 24h margin absorbs any realistic
 * skew, but the safety argument does span two clocks.
 */
export interface PruneResult {
  deleted: number
  /**
   * True when the run stopped at its batch ceiling with work still to do. A
   * count alone cannot say this — "10,000 deleted" reads identically whether
   * that drained the backlog or merely dented it — and it is the one signal
   * worth alerting on, because it means the table is outgrowing the schedule.
   */
  exhausted: boolean
}

export async function pruneMutationOutcomes(
  db: PrismaClient,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const cutoff = new Date(now.getTime() - MUTATION_RETENTION_MS)

  let deleted = 0
  let exhausted = true

  for (let batch = 0; batch < maxBatches; batch++) {
    // Select the batch first, then delete by primary key. `deleteMany` has no
    // LIMIT, so filtering on the timestamp alone would delete the whole
    // backlog in one statement — the thing batching exists to avoid.
    const expiring = await db.mutationOutcome.findMany({
      where: { createdAt: { lt: cutoff } },
      // Oldest first: makes the index scan and the intent explicit rather than
      // relying on whatever order the planner happens to return.
      orderBy: { createdAt: 'asc' },
      select: { mutationId: true },
      take: batchSize,
    })
    if (expiring.length === 0) {
      exhausted = false
      break
    }

    const { count } = await db.mutationOutcome.deleteMany({
      where: { mutationId: { in: expiring.map((r) => r.mutationId) } },
    })
    deleted += count

    // A short batch means the backlog is drained. Safe here specifically
    // because no concurrent insert can ever produce an EXPIRED row, so "fewer
    // than asked for" genuinely means "no more exist" rather than "none were
    // visible yet".
    if (expiring.length < batchSize) {
      exhausted = false
      break
    }
  }

  return { deleted, exhausted }
}


/**
 * How long a `DropNotice` row is kept after it stops being displayable.
 *
 * The table is append-only on every drop path, so without this it grows
 * forever — the same unbounded-growth problem `MutationOutcome` has, with the
 * same fix. Deletion is safe here in a way outbox deletion is not: a notice
 * past `NOTICE_GRACE_MS` is already invisible to `activeDropNotices`, so
 * pruning removes rows nobody can see rather than rows somebody might still
 * need. The extra 30 days beyond the grace window is slack for anyone reading
 * the table directly to answer "was this member told?".
 */
export const DROP_NOTICE_RETENTION_MS = NOTICE_GRACE_MS + 30 * 24 * 60 * 60 * 1000

/**
 * Deletes drop notices that can no longer be displayed.
 *
 * A row qualifies only when BOTH clocks `activeDropNotices` consults have run
 * out — `shiftStartsAt` and `createdAt`. Keying on either one alone would
 * delete rows the page still shows: a notice written today about a shift that
 * started last month is live (recent `createdAt`), and so is a months-old
 * notice about a shift still ahead (future `shiftStartsAt`).
 */
export async function pruneDropNotices(
  db: PrismaClient,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const cutoff = new Date(now.getTime() - DROP_NOTICE_RETENTION_MS)

  let deleted = 0
  let exhausted = true

  for (let batch = 0; batch < maxBatches; batch++) {
    const expiring = await db.dropNotice.findMany({
      where: {
        createdAt: { lt: cutoff },
        // NULL means the times were never recovered, which cannot keep a row
        // alive forever — `createdAt` alone governs those.
        OR: [{ shiftStartsAt: null }, { shiftStartsAt: { lt: cutoff } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: batchSize,
    })
    if (expiring.length === 0) {
      exhausted = false
      break
    }

    const { count } = await db.dropNotice.deleteMany({
      where: { id: { in: expiring.map((r) => r.id) } },
    })
    deleted += count

    if (expiring.length < batchSize) {
      exhausted = false
      break
    }
  }

  return { deleted, exhausted }
}

/**
 * How long `EventOutbox` rows are kept.
 *
 * These exist purely so a client that was away can replay what it missed. A
 * client polls every few seconds and catches up whenever its tab becomes
 * visible, so the practical requirement is minutes — but a laptop closed over a
 * weekend should still replay rather than resync, and a resync is only a
 * `router.refresh()`, so erring long costs little either way.
 *
 * Unlike `MutationOutcome`, expiry here is SAFE to get wrong in the short
 * direction — but only because `prunedUpTo` tells a stranded client to resync.
 * Without that signal any expiry at all silently loses events. Do not shorten
 * this, or prune at all, without that watermark being written in the same
 * transaction as the delete.
 */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** The singleton watermark row's id. */
const WATERMARK_ID = 1

/**
 * Highest `EventOutbox.id` that has been pruned away.
 *
 * `0n` when nothing has ever been pruned — which is also the correct answer for
 * a fresh database, since no client can have missed anything.
 */
export async function prunedWatermark(db: PrismaClient): Promise<bigint> {
  const row = await db.outboxWatermark.findUnique({ where: { id: WATERMARK_ID } })
  // `BigInt(0)`, not `0n`: tsconfig targets ES2017, which predates BigInt literals.
  return row?.prunedUpTo ?? BigInt(0)
}

/**
 * Deletes expired `EventOutbox` rows and records how far pruning has reached.
 *
 * The delete and the watermark advance happen in ONE transaction, and that is
 * the whole safety argument. Rows disappearing without the watermark moving is
 * precisely the silent-data-loss case: a client polling `id > lastId` for
 * deleted events gets an empty page and concludes it is up to date. Committing
 * them together means a stranded cursor is always detectable.
 *
 * Batched like `pruneMutationOutcomes`, for the same reason.
 */
export async function pruneEventOutbox(
  db: PrismaClient,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_MS)

  let deleted = 0
  let exhausted = true

  for (let batch = 0; batch < maxBatches; batch++) {
    const expiring = await db.eventOutbox.findMany({
      where: { createdAt: { lt: cutoff } },
      // Oldest first, so the highest id in the batch is the furthest point
      // pruning has reached — which is exactly what the watermark records.
      orderBy: { id: 'asc' },
      select: { id: true },
      take: batchSize,
    })
    if (expiring.length === 0) {
      exhausted = false
      break
    }

    const highest = expiring[expiring.length - 1]!.id

    const count = await db.$transaction(async (tx) => {
      const { count } = await tx.eventOutbox.deleteMany({
        where: { id: { in: expiring.map((r) => r.id) } },
      })

      // ONE statement, deliberately. A read-modify-write here (findUnique, then
      // create-or-update) compares against a value that another run can have
      // moved in between: run B commits 200, run A — holding a stale read of 0
      // and having already passed its own guard — then writes 100. Rows up to
      // 200 are gone while the watermark claims 100, so a client at 150 is told
      // it is fine and silently loses events. `GREATEST` in the same statement
      // as the write makes the comparison and the write atomic, and makes a
      // concurrent first-ever prune a no-op rather than a P2002.
      await tx.$executeRaw`
        INSERT INTO "OutboxWatermark" ("id", "prunedUpTo", "updatedAt")
        VALUES (${WATERMARK_ID}, ${highest}, now())
        ON CONFLICT ("id") DO UPDATE
          SET "prunedUpTo" = GREATEST("OutboxWatermark"."prunedUpTo", EXCLUDED."prunedUpTo"),
              "updatedAt"  = now()
      `

      return count
    }, TX_OPTIONS)

    deleted += count

    if (expiring.length < batchSize) {
      exhausted = false
      break
    }
  }

  return { deleted, exhausted }
}
