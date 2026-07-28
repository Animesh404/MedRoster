import { afterAll, describe, expect, it } from 'vitest'
import { withRetry, pgCode } from '@/lib/rules/retry'
import { getTestDb, stopTestDb } from '../helpers/db'

afterAll(stopTestDb)

/** A fresh, unused advisory-lock namespace so this file never collides with a
 *  lock `withOrderedLocks` might be holding elsewhere. */
const NS = 99

/**
 * Acquires two advisory locks, in the given order, with a delay between them.
 * Two calls with opposite orders and overlapping delays force a REAL Postgres
 * deadlock (SQLSTATE 40P01) — this is not simulated or mocked.
 */
function lockBothInOrder(
  db: Awaited<ReturnType<typeof getTestDb>>,
  first: number,
  second: number,
  delayMs: number,
) {
  return withRetry(() =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS}::int, ${first}::int)`
      await new Promise((r) => setTimeout(r, delayMs))
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS}::int, ${second}::int)`
      return 'ok' as const
    }),
  )
}

describe('withRetry against a genuine Postgres deadlock', () => {
  it('recognises a real 40P01 (nested under meta.driverAdapterError.cause.code) and recovers', async () => {
    const db = await getTestDb()

    // Transaction A takes lock 1 then lock 2; transaction B takes lock 2 then
    // lock 1 — a classic opposite-order deadlock. Postgres's deadlock detector
    // (default deadlock_timeout = 1s) will pick one victim and abort it with
    // 40P01. If `withRetry` doesn't recognise that code, the aborted side
    // rejects and this whole Promise.all rejects — failing the test. If it
    // does recognise it (via `pgCode`), the aborted side retries once the
    // winner has released its locks, and both calls resolve 'ok'.
    const [a, b] = await Promise.all([
      lockBothInOrder(db, 1, 2, 100),
      lockBothInOrder(db, 2, 1, 100),
    ])

    expect(a).toBe('ok')
    expect(b).toBe('ok')
    // No explicit timeout override — inherit the config's generous default
    // (see vitest.config.ts), since under parallel full-suite load the 1s
    // deadlock_timeout detection plus retry backoff can take longer than a
    // tight local override would allow.
  })
})

describe('pgCode', () => {
  it('reads the SQLSTATE nested at meta.driverAdapterError.cause.code (Prisma 7 + pg adapter shape)', () => {
    const err = {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { code: '40P01' } } },
    }
    expect(pgCode(err)).toBe('40P01')
  })

  it('falls back to a plain err.code when there is no nested driver-adapter error', () => {
    expect(pgCode({ code: '40001' })).toBe('40001')
  })

  it('returns undefined for an error with neither shape', () => {
    expect(pgCode(new Error('boom'))).toBeUndefined()
  })
})
