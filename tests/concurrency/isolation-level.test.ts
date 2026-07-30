import { readFileSync } from 'node:fs'
import { Prisma } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { TX_OPTIONS } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const FUTURE = new Date('2026-12-01T09:00:00Z')
const FUTURE_END = new Date('2026-12-01T17:00:00Z')

beforeEach(resetTestDb)
afterAll(stopTestDb)

/**
 * Reproduces `assignClaim`'s read-count-then-write shape verbatim, but with the
 * isolation level swapped to RepeatableRead. It exists ONLY to document, in a
 * form that fails loudly, why `./locks.ts` and `./assign.ts` say isolation must
 * stay pinned at ReadCommitted (see the comment on `withOrderedLocks`).
 *
 * Under RepeatableRead, Postgres takes each transaction's snapshot at its
 * FIRST statement — the advisory-lock acquisition itself — and it takes that
 * snapshot BEFORE the lock is granted. So every concurrent claimant queues on
 * the lock but reads the shift's claim count through a snapshot frozen before
 * any of them started writing: every one of them sees zero prior claims, and
 * every one of them proceeds to insert. The lock still serializes the writes —
 * it just can no longer make the reads honest, which is exactly what
 * `validateAssignment`'s count check depends on.
 */
async function assignAtRepeatableRead(
  db: Awaited<ReturnType<typeof getTestDb>>,
  shiftId: number,
  userId: number,
  requiredCount: number,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1::int, ${shiftId}::int)`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2::int, ${userId}::int)`

      const filled = await tx.claim.count({ where: { shiftId } })
      if (filled >= requiredCount) return { code: 'ROLE_FULL' as const }

      await tx.claim.create({ data: { shiftId, userId } })
      return { claimId: userId }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

describe('isolation level is load-bearing, not incidental', () => {
  it('DOCUMENTS THE BUG: the same lock-then-read-then-write shape oversells under RepeatableRead', async () => {
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: FUTURE, endsAt: FUTURE_END,
        requirements: { create: [{ profession: 'NURSE', requiredCount: 3 }] },
      },
    })
    const nurses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.user.create({
          data: {
            email: `rr${i}@c.test`, name: `RR Nurse ${i}`,
            role: 'STAFF', profession: 'NURSE',
          },
        })),
    )

    const results = await Promise.all(
      nurses.map((n) => assignAtRepeatableRead(db, shift.id, n.id, 3)),
    )
    const won = results.filter((r) => 'claimId' in r)
    const dbCount = await db.claim.count({ where: { shiftId: shift.id } })

    // The requirement was 3. Under the correct ReadCommitted level (see the
    // production `assignClaim` concurrency tests) exactly 3 win. Here, under
    // RepeatableRead, we expect an oversell: more than 3 winners, and the
    // winner count exactly matches the row count (nothing else went wrong —
    // the lock still prevents double-writes, it just can't stop everyone from
    // reading "0 claimed" at once).
    expect(won.length).toBeGreaterThan(3)
    expect(dbCount).toBe(won.length)
    // No explicit timeout override — see vitest.config.ts's hookTimeout comment;
    // the same reasoning applies to this test's own runtime under load.
  })

  it('asserts the production call sites actually pin ReadCommitted, so this cannot silently regress', () => {
    // Belt-and-braces alongside the live reproduction above: a fast, fully
    // deterministic guard (no timing dependency) that fails immediately if a
    // future edit changes or drops the isolation level at any $transaction
    // call site in assign.ts OR edit.ts — both share the same `withOrderedLocks`
    // correctness argument (MINOR-6).
    // Deliberately exact rather than `toMatchObject`: the point of this guard
    // is that ANY drift in the shared transaction options is noticed, not just
    // a change to the isolation level. `maxWait`/`timeout` were added to fix
    // the P2028 capacity failure in docs/KNOWN_ISSUES.md — if you are here
    // because this assertion failed, confirm your change is intentional and
    // update the expected shape, rather than relaxing the comparison.
    expect(TX_OPTIONS).toEqual({
      isolationLevel: 'ReadCommitted',
      maxWait: 15_000,
      timeout: 20_000,
    })

    for (const file of ['assign.ts', 'edit.ts']) {
      const source = readFileSync(new URL(`../../lib/rules/${file}`, import.meta.url), 'utf8')
      const transactionCallSites = source.match(/\$transaction\(/g) ?? []
      // TX_OPTIONS is passed as the second argument to `$transaction`, immediately
      // followed by either a comma (more args/formatting on the next line) or the
      // call's closing paren — matching both files' formatting styles.
      const pinnedCallSites = source.match(/TX_OPTIONS[,)]/g) ?? []
      expect(transactionCallSites.length).toBeGreaterThanOrEqual(1)
      expect(pinnedCallSites.length).toBe(transactionCallSites.length)
    }
  })
})
