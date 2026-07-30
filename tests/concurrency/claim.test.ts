import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim, unassignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const FUTURE = new Date('2026-12-01T09:00:00Z')
const FUTURE_END = new Date('2026-12-01T17:00:00Z')

async function seedShiftAndNurses(nurseCount: number, requiredNurses = 2) {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: FUTURE_END,
      requirements: {
        create: [
          { profession: 'NURSE', requiredCount: requiredNurses },
          { profession: 'DOCTOR', requiredCount: 0 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ],
      },
    },
  })
  const nurses = await Promise.all(
    Array.from({ length: nurseCount }, (_, i) =>
      db.user.create({
        data: {
          email: `n${i}@c.test`, name: `Nurse ${i}`,
          role: 'STAFF', profession: 'NURSE',
        },
      })),
  )
  return { shift, nurses }
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('concurrent claiming', () => {
  it('lets exactly 2 of 10 simultaneous nurses onto a 2-nurse shift', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(10, 2)

    const results = await Promise.all(
      nurses.map((n) => assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })),
    )

    const won = results.filter((r) => 'claimId' in r)
    const lost = results.filter((r) => 'code' in r)

    expect(won).toHaveLength(2)
    expect(lost).toHaveLength(8)
    expect(lost.every((r) => (r as { code: string }).code === 'ROLE_FULL')).toBe(true)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(2)
  })

  it('never lets the same nurse claim one shift twice under a race', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(1, 2)
    const nurse = nurses[0]!

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })),
    )

    expect(results.filter((r) => 'claimId' in r)).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
  })

  it('rejects the second of two overlapping shifts claimed simultaneously', async () => {
    const db = await getTestDb()
    const { nurses } = await seedShiftAndNurses(1, 2)
    const nurse = nurses[0]!

    const mk = (startsAt: Date, endsAt: Date) => db.shift.create({
      data: {
        startsAt, endsAt,
        requirements: { create: [
          { profession: 'NURSE', requiredCount: 2 },
          { profession: 'DOCTOR', requiredCount: 0 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ] },
      },
    })

    const a = await mk(new Date('2026-12-02T09:00:00Z'), new Date('2026-12-02T17:00:00Z'))
    const b = await mk(new Date('2026-12-02T14:00:00Z'), new Date('2026-12-02T22:00:00Z'))

    const results = await Promise.all([
      assignClaim({ db, shiftId: a.id, userId: nurse.id, actorId: nurse.id }),
      assignClaim({ db, shiftId: b.id, userId: nurse.id, actorId: nurse.id }),
    ])

    expect(results.filter((r) => 'claimId' in r)).toHaveLength(1)
    expect(results.filter((r) => 'code' in r && r.code === 'OVERLAP')).toHaveLength(1)
    expect(await db.claim.count({ where: { userId: nurse.id } })).toBe(1)
  })

  it('writes exactly one outbox event per successful claim', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(10, 2)

    await Promise.all(nurses.map((n) =>
      assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })))

    expect(await db.eventOutbox.count({ where: { type: 'shift.claimed' } })).toBe(2)
  })

  it('lets exactly 3 of 50 simultaneous nurses onto a 3-nurse shift', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(50, 3)

    const results = await Promise.all(
      nurses.map((n) => assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })),
    )

    const won = results.filter((r) => 'claimId' in r)
    const lost = results.filter((r) => 'code' in r)

    expect(won).toHaveLength(3)
    expect(lost).toHaveLength(47)
    expect(lost.every((r) => (r as { code: string }).code === 'ROLE_FULL')).toBe(true)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(3)
  })

  it('mixed concurrent claims and unclaims on one shift never oversell, never go negative, and stay event-consistent', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(6, 3)
    const [holder0, holder1, holder2, fresh3, fresh4, fresh5] = nurses

    // Establish a baseline: three incumbents already hold the shift.
    for (const n of [holder0!, holder1!, holder2!]) {
      const r = await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })
      expect('claimId' in r).toBe(true)
    }

    // Race two unclaims against three fresh claims on the same 3-nurse shift.
    await Promise.all([
      unassignClaim({ db, shiftId: shift.id, userId: holder0!.id }),
      unassignClaim({ db, shiftId: shift.id, userId: holder1!.id }),
      assignClaim({ db, shiftId: shift.id, userId: fresh3!.id, actorId: fresh3!.id }),
      assignClaim({ db, shiftId: shift.id, userId: fresh4!.id, actorId: fresh4!.id }),
      assignClaim({ db, shiftId: shift.id, userId: fresh5!.id, actorId: fresh5!.id }),
    ])

    const dbCount = await db.claim.count({ where: { shiftId: shift.id } })
    expect(dbCount).toBeGreaterThanOrEqual(0)
    expect(dbCount).toBeLessThanOrEqual(3)

    const claimedEvents = await db.eventOutbox.count({ where: { type: 'shift.claimed' } })
    const unclaimedEvents = await db.eventOutbox.count({ where: { type: 'shift.unclaimed' } })
    expect(claimedEvents - unclaimedEvents).toBe(dbCount)
  })

  it('a manager assigning and the staff member self-claiming the same 1-nurse shift race to exactly one winner', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(1, 1)
    const nurse = nurses[0]!
    const manager = await db.user.create({
      data: { email: 'mgr@c.test', name: 'Manager', role: 'MANAGER', profession: null },
    })

    const results = await Promise.all([
      assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id }),
      assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: manager.id }),
    ])

    expect(results.filter((r) => 'claimId' in r)).toHaveLength(1)
    expect(results.filter((r) => 'code' in r && r.code === 'ALREADY_CLAIMED')).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id, userId: nurse.id } })).toBe(1)
  })

  it('records assignedById as the manager on assignment and null on self-claim', async () => {
    const db = await getTestDb()
    const manager = await db.user.create({
      data: { email: 'mgr2@c.test', name: 'Manager', role: 'MANAGER', profession: null },
    })
    const { shift, nurses } = await seedShiftAndNurses(2, 2)
    const [selfNurse, assignedNurse] = nurses

    const selfResult = await assignClaim({ db, shiftId: shift.id, userId: selfNurse!.id, actorId: selfNurse!.id })
    const assignResult = await assignClaim({ db, shiftId: shift.id, userId: assignedNurse!.id, actorId: manager.id })

    if (!('claimId' in selfResult)) throw new Error(`expected self-claim to succeed, got ${JSON.stringify(selfResult)}`)
    if (!('claimId' in assignResult)) throw new Error(`expected manager assignment to succeed, got ${JSON.stringify(assignResult)}`)

    const selfClaim = await db.claim.findUniqueOrThrow({ where: { id: selfResult.claimId } })
    const assignedClaim = await db.claim.findUniqueOrThrow({ where: { id: assignResult.claimId } })

    expect(selfClaim.assignedById).toBeNull()
    expect(assignedClaim.assignedById).toBe(manager.id)
  })
})
