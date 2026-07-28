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
