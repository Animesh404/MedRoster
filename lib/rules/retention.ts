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
 * This cannot contend with live claiming. A claim in flight writes a row with
 * `createdAt = now`, which the expiry predicate can never match, so the pruner
 * and the claim path never touch the same rows — and the pruner takes no
 * advisory lock, so it never joins the queue `withOrderedLocks` manages.
 *
 * Returns the number deleted, so a caller can log it and notice a table that
 * is growing faster than a run can clear.
 */
export async function pruneMutationOutcomes(
  db: PrismaClient,
  opts: PruneOptions = {},
): Promise<number> {
  const now = opts.now ?? new Date()
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES
  const cutoff = new Date(now.getTime() - MUTATION_RETENTION_MS)

  let deleted = 0

  for (let batch = 0; batch < maxBatches; batch++) {
    // Select the batch first, then delete by primary key. `deleteMany` has no
    // LIMIT, so filtering on the timestamp alone would delete the whole
    // backlog in one statement — the thing batching exists to avoid.
    const expiring = await db.mutationOutcome.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { mutationId: true },
      take: batchSize,
    })
    if (expiring.length === 0) break

    const { count } = await db.mutationOutcome.deleteMany({
      where: { mutationId: { in: expiring.map((r) => r.mutationId) } },
    })
    deleted += count

    // A short final batch means the backlog is drained; no need to ask again.
    if (expiring.length < batchSize) break
  }

  return deleted
}
