import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

/**
 * The capacity guard for idempotency, which is otherwise invisible.
 *
 * Every other concurrency test passes NO `mutationId`, so they all measure the
 * pre-idempotency path. Keyed calls do two extra round-trips — a `SELECT` for
 * the replay check and an `INSERT` to record the outcome — and both sit INSIDE
 * the shift's advisory lock, on the losing path as well as the winning one.
 * That directly inflates the number `TX_OPTIONS.maxWait` (15s) was sized
 * against: `docs/KNOWN_ISSUES.md` records ~30ms per claimant putting the 50th
 * roughly 1.5s deep.
 *
 * Measured when this landed: 50 keyed claimants finished in ~750ms with zero
 * `BUSY`, so the added work costs well under the available headroom. This test
 * exists so that stops being true loudly, rather than as an intermittent 503.
 */
describe('keyed burst', () => {
  it('50 simultaneous claims carrying mutationIds still admit exactly 3, with no capacity failures', async () => {
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-12-01T09:00:00Z'),
        endsAt: new Date('2026-12-01T17:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 3 }] },
      },
    })
    const nurses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        db.user.create({
          data: { email: `b${i}@c.test`, name: `B${i}`, role: 'STAFF', profession: 'NURSE' },
        })),
    )

    const results = await Promise.all(
      nurses.map((n) =>
        assignClaim({
          db, shiftId: shift.id, userId: n.id, actorId: n.id, mutationId: `burst-${n.id}`,
        })),
    )

    const won = results.filter((r) => 'claimId' in r)
    const busy = results.filter((r) => 'code' in r && (r as { code: string }).code === 'BUSY')

    expect(won).toHaveLength(3)
    // A BUSY here means the extra keyed work pushed the queue past `maxWait`.
    // That is the regression this test exists for; it would otherwise surface
    // as an intermittent 503 for a legitimate claimant under load.
    expect(busy).toHaveLength(0)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(3)
    // One record per claimant: every outcome, winning and losing, is idempotent.
    expect(await db.mutationOutcome.count()).toBe(50)
  })
})
