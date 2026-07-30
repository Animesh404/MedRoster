import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deactivateMember, type BanAdminPort } from '@/lib/members/deactivate'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const NOW = new Date('2026-08-01T12:00:00Z')
const FUTURE = new Date('2026-08-10T09:00:00Z')

function fakeAdmin() {
  const port: BanAdminPort = {
    updateUserById: () => Promise.resolve({ error: null }),
  }
  return port
}

async function seedMemberWithFutureClaim() {
  const db = await getTestDb()
  const nurse = await db.user.create({
    data: { email: 'racer@c.test', name: 'Racer', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-racer' },
  })
  const future = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: new Date('2026-08-10T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  await db.claim.create({ data: { shiftId: future.id, userId: nurse.id } })
  return { db, nurse, future }
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('concurrent deactivation', () => {
  // Genuinely simultaneous, unlike the sequential idempotency test in
  // tests/members/deactivate.test.ts (which awaits the first call to
  // completion before starting the second, and so only proves ordinary
  // re-invocation is safe). This fires both calls with Promise.all so their
  // transactions genuinely overlap under READ COMMITTED — the exact
  // condition `withOrderedLocks` exists to serialise.
  it('two simultaneous deactivateMember calls for the same member release the shift exactly once', async () => {
    const { db, nurse, future } = await seedMemberWithFutureClaim()
    const port = fakeAdmin()

    const [a, b] = await Promise.all([
      deactivateMember(db, port, nurse.id, { now: NOW }),
      deactivateMember(db, port, nurse.id, { now: NOW }),
    ])

    // Exactly one of the two callers should observe the release; the other
    // must find the profile already marked (by the lock-losing transaction
    // reading the winner's committed state) and release nothing.
    const nonEmpty = [a, b].filter((r) => 'releasedShiftIds' in r && r.releasedShiftIds.length > 0)
    const empty = [a, b].filter((r) => 'releasedShiftIds' in r && r.releasedShiftIds.length === 0)
    expect(nonEmpty).toHaveLength(1)
    expect(empty).toHaveLength(1)
    expect(nonEmpty[0]).toMatchObject({ releasedShiftIds: [future.id] })

    // The race this test exists to catch: without the advisory lock, both
    // transactions can read `deactivatedAt: null` before either commits,
    // both compute the same doomed claim, and both unconditionally emit —
    // producing a second identical "was dropped" line in the shift activity
    // feed and a second identical drop notice in my-shifts.
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(1)

    expect(await db.claim.count({ where: { shiftId: future.id, userId: nurse.id } })).toBe(0)

    // A single deactivatedAt value survives the race — not overwritten by
    // whichever transaction happened to commit last.
    const profile = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    expect(profile.deactivatedAt).toBeInstanceOf(Date)
    expect(profile.deactivatedAt!.getTime()).toBe(NOW.getTime())
  })
})
