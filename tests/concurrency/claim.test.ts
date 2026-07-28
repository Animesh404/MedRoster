import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
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
          email: `n${i}@c.test`, name: `Nurse ${i}`, passwordHash: 'x',
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
})
