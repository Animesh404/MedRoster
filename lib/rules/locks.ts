import type { Prisma } from '@prisma/client'

/** Advisory-lock namespaces. Distinct so a shift id and a user id never collide. */
const NS = { SHIFT: 1, USER: 2 } as const

/**
 * Takes transaction-scoped advisory locks in a fixed global order — all shift
 * ids first, then all user ids, each ascending (§4.2).
 *
 * The ordering is the whole point: a shift edit locks one shift and many users
 * while a staff member may be concurrently claiming. Without a total order those
 * two can deadlock; with one they simply queue.
 *
 * CORRECT ONLY UNDER READ COMMITTED. Every caller MUST run this inside a
 * transaction opened with `{ isolationLevel: 'ReadCommitted' }` (the default —
 * but callers must pin it explicitly, since the default is one config change
 * away from silently changing). Under REPEATABLE READ or SERIALIZABLE, Postgres
 * takes the transaction's snapshot at its FIRST statement — which, here, is the
 * `pg_advisory_xact_lock` call below — and it takes that snapshot BEFORE the lock
 * is granted, not after. So every read this function's caller does once the lock
 * finally *is* held is still looking at the pre-lock, stale snapshot: two
 * transactions can both acquire the lock in turn, and both still see the count
 * as it was before either of them started. That is not a hypothetical — it was
 * reproduced 3/3 as 12 winners claiming a 3-nurse shift with this exact code at
 * RepeatableRead. Under READ COMMITTED, by contrast, each statement gets a fresh
 * snapshot, so a read taken after the lock is granted genuinely reflects
 * everything the lock serialized in front of it. Do not "upgrade" the isolation
 * level here without re-deriving this argument from scratch.
 */
export async function withOrderedLocks<T>(
  tx: Prisma.TransactionClient,
  ids: { shiftIds?: number[]; userIds?: number[] },
  fn: () => Promise<T>,
): Promise<T> {
  const shiftIds = [...new Set(ids.shiftIds ?? [])].sort((a, b) => a - b)
  const userIds = [...new Set(ids.userIds ?? [])].sort((a, b) => a - b)

  for (const id of shiftIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS.SHIFT}::int, ${id}::int)`
  }
  for (const id of userIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS.USER}::int, ${id}::int)`
  }

  return fn()
}
