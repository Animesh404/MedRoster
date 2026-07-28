import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { commitShiftEdit, previewShiftEdit } from '@/lib/rules/edit'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const D = (s: string) => new Date(s)

async function makeShift(startsAt: Date, endsAt: Date, nurses = 2, doctors = 0) {
  const db = await getTestDb()
  return db.shift.create({
    data: {
      startsAt, endsAt,
      requirements: { create: [
        { profession: 'NURSE', requiredCount: nurses },
        { profession: 'DOCTOR', requiredCount: doctors },
        { profession: 'RECEPTIONIST', requiredCount: 0 },
      ] },
    },
  })
}

async function makeNurse(i: number) {
  const db = await getTestDb()
  return db.user.create({
    data: { email: `n${i}@c.test`, name: `Nurse ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
  })
}

const REQ = { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } as const

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('previewShiftEdit', () => {
  it('keeps every claim when the new time breaks nothing', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { ...REQ },
    })

    expect('dropped' in preview && preview.dropped).toEqual([])
    expect('kept' in preview && preview.kept).toEqual([nurse.id])
  })

  it('drops the claim that the new time makes overlap another shift', async () => {
    const db = await getTestDb()
    const a = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const b = await makeShift(D('2026-12-02T09:00Z'), D('2026-12-02T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: a.id, userId: nurse.id, actorId: nurse.id })
    await assignClaim({ db, shiftId: b.id, userId: nurse.id, actorId: nurse.id })

    // Move b on top of a
    const preview = await previewShiftEdit(db, b.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { ...REQ },
    })

    expect('dropped' in preview && preview.dropped).toHaveLength(1)
    expect('dropped' in preview && preview.dropped[0]!.code).toBe('OVERLAP')
  })

  it('drops the most recently claimed person when the requirement is lowered', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })
    await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    })

    expect('dropped' in preview && preview.dropped.map((d) => d.userId)).toEqual([second.id])
    expect('kept' in preview && preview.kept).toEqual([first.id])
  })

  it('changes nothing in the database', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 1 },
    })

    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(0)
  })
})

describe('commitShiftEdit', () => {
  it('applies the edit, drops the right claims and bumps the version', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })
    await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })

    const result = await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }, 0)

    expect('dropped' in result && result.dropped).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(1)
  })

  it('refuses a stale confirm when a claim landed after the preview', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt, requirements: { ...REQ },
    })
    const stale = ('version' in preview ? preview.version : 0)

    // A concurrent edit bumps the version between preview and confirm.
    await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt, requirements: { ...REQ },
    }, stale)

    const result = await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 1 },
    }, stale)

    expect('code' in result && result.code).toBe('VERSION_CONFLICT')
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
  })

  it('emits a claims_dropped event only when somebody was actually dropped', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 1)
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    await commitShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }, 0)
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(0)

    await commitShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'),
      requirements: { NURSE: 0, DOCTOR: 1, RECEPTIONIST: 0 },
    }, 1)
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(1)
  })
})
