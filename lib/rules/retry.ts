/**
 * Reads the Postgres SQLSTATE off an error thrown by a Prisma query, across the
 * shapes Prisma 7 + `@prisma/adapter-pg` actually produce.
 *
 * Verified against forced real deadlocks and serialization failures: Prisma 7 on
 * the pg driver adapter does NOT surface the SQLSTATE at the top-level `err.code`
 * — that field holds Prisma's own error code instead (`P2010` for a raw query,
 * `P2039` for a model operation). The underlying Postgres code is nested at
 * `err.meta.driverAdapterError.cause.code`. We check that path first and fall
 * back to `err.code` for any Prisma/driver combination that puts it there directly.
 */
export function pgCode(err: unknown): string | undefined {
  const e = err as {
    code?: string
    meta?: { driverAdapterError?: { cause?: { code?: string } } }
  }
  return e.meta?.driverAdapterError?.cause?.code ?? e.code
}

/**
 * Prisma error codes meaning "this transaction never got to run", as opposed
 * to "it ran and lost".
 *
 *  - P2028 — interactive transaction could not START within `maxWait`.
 *  - P2024 — could not get a connection from the pool within its timeout.
 *
 * Both are capacity signals, and both are why this module needed widening.
 * `withOrderedLocks` deliberately serialises every claimant of a shift behind
 * one advisory lock, and a transaction blocked on that lock is holding a pool
 * connection while it waits. A burst of claimants on a single shift — the
 * exact "shift drop" this app is built for — therefore queues, and the
 * claimants at the back of the queue exhaust `maxWait` before their
 * transaction ever opens.
 *
 * Previously these fell straight through `withRetry` (which only knew about
 * 40001/40P01), out of `assignClaim`, and into `withAuth`'s catch-all, where a
 * legitimate claimant who should have seen a clean `ROLE_FULL` got an HTTP 500
 * instead. See docs/KNOWN_ISSUES.md for the reproduction.
 */
export function isCapacityError(err: unknown): boolean {
  const code = pgCode(err)
  return code === 'P2028' || code === 'P2024'
}

/** Postgres codes worth retrying: the transaction ran and lost a race. */
function isRaceError(err: unknown): boolean {
  const code = pgCode(err)
  // 40001 serialization_failure, 40P01 deadlock_detected
  return code === '40001' || code === '40P01'
}

/**
 * Retries a transaction on serialization failure, deadlock, and the capacity
 * errors above (§4.2).
 *
 * Backoff is exponential with jitter rather than the previous linear 10/20/30ms.
 * Under a burst the linear schedule kept every loser retrying in nearly the same
 * narrow window, which is a thundering herd against a lock that can only admit
 * one of them at a time. Jitter spreads the retries out, which is what actually
 * drains the queue.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRaceError(err) && !isCapacityError(err)) throw err
      lastError = err
      // 25ms, 50ms, 100ms … each with up to 100% jitter on top.
      const base = 25 * 2 ** i
      await new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * base)))
    }
  }
  throw lastError
}
