import type { PrismaClient } from '@prisma/client'

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
