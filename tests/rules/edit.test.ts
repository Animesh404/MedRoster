import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import {
  commitShiftDelete, commitShiftEdit, previewShiftDelete, previewShiftEdit,
} from '@/lib/rules/edit'
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

/** Fetches a fresh preview and unwraps its `{ version, claimsToken }` pair —
 *  the shape `commitShiftEdit`/`commitShiftDelete` expect as `expected`. */
async function expectFromPreview(preview: { version: number; claimsToken: string } | unknown) {
  if (!preview || typeof preview !== 'object' || !('claimsToken' in preview)) {
    throw new Error(`expected a successful preview, got ${JSON.stringify(preview)}`)
  }
  const p = preview as { version: number; claimsToken: string }
  return { version: p.version, claimsToken: p.claimsToken }
}

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

  it('rejects a P2025 race gracefully instead of throwing a raw Prisma error (IMPORTANT-4)', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    await db.shift.delete({ where: { id: shift.id } })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { ...REQ },
    })

    expect('code' in preview && preview.code).toBe('NOT_FOUND')
  })

  it('rejects an inverted or past interval up front with INVALID_INPUT (MINOR-11)', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))

    const inverted = await previewShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T18:00Z'), endsAt: D('2026-12-01T10:00Z'), requirements: { ...REQ },
    })
    expect('code' in inverted && inverted.code).toBe('INVALID_INPUT')

    const past = await previewShiftEdit(db, shift.id, {
      startsAt: D('2020-01-01T09:00Z'), endsAt: D('2020-01-01T17:00Z'), requirements: { ...REQ },
    })
    expect('code' in past && past.code).toBe('INVALID_INPUT')

    // Neither rejected proposal touched the database.
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

    const proposed = {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }
    const preview = await previewShiftEdit(db, shift.id, proposed)
    const result = await commitShiftEdit(db, shift.id, proposed, await expectFromPreview(preview))

    expect('dropped' in result && result.dropped).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(1)
  })

  it('refuses a stale confirm when a concurrent edit bumped the version', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })

    const proposed = { startsAt: shift.startsAt, endsAt: shift.endsAt, requirements: { ...REQ } }
    const preview = await previewShiftEdit(db, shift.id, proposed)
    const stale = await expectFromPreview(preview)

    // A concurrent edit bumps the version between preview and confirm.
    await commitShiftEdit(db, shift.id, proposed, stale)

    const result = await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 1 },
    }, stale)

    expect('code' in result && result.code).toBe('VERSION_CONFLICT')
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
  })

  it('CRITICAL-1: refuses a stale confirm when a claim landed after the preview, even though the version never moved', async () => {
    const db = await getTestDb()
    // Room for 2 nurses: the preview and commit both request only 1, so the
    // claim that lands after the preview isn't itself invalidated by the
    // requirement change — it survives purely because of the race, exactly
    // the scenario the review reproduced.
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })

    const proposed = {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }
    const preview = await previewShiftEdit(db, shift.id, proposed)
    expect('dropped' in preview && preview.dropped).toEqual([])
    const stale = await expectFromPreview(preview)

    // `Shift.version` is bumped only by commitShiftEdit/commitShiftDelete —
    // never by assignClaim — so the version alone is unchanged by this claim.
    const claimResult = await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })
    expect('claimId' in claimResult).toBe(true)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(stale.version)

    const result = await commitShiftEdit(db, shift.id, proposed, stale)

    expect('code' in result && result.code).toBe('VERSION_CONFLICT')
    // The refused commit touched nothing: both claims (first kept from
    // before, second landed via the race) are still exactly as they were,
    // and the version is still unbumped.
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(2)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(stale.version)
  })

  it('emits a claims_dropped event only when somebody was actually dropped', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 1)
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const first = {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'),
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }
    const preview1 = await previewShiftEdit(db, shift.id, first)
    await commitShiftEdit(db, shift.id, first, await expectFromPreview(preview1))
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(0)

    const second = {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'),
      requirements: { NURSE: 0, DOCTOR: 1, RECEPTIONIST: 0 },
    }
    const preview2 = await previewShiftEdit(db, shift.id, second)
    await commitShiftEdit(db, shift.id, second, await expectFromPreview(preview2))
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(1)
  })

  it('MINOR-3: breaks a createdAt tie by claim id, not unspecified heap order', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    const firstClaim = await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })
    const secondClaim = await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })
    if (!('claimId' in firstClaim) || !('claimId' in secondClaim)) throw new Error('expected both claims to succeed')

    // Force an exact createdAt tie — the scenario the review reproduced via a
    // real VACUUM FULL, without needing an actual vacuum to demonstrate it.
    const tie = new Date('2026-01-01T00:00:00Z')
    await db.claim.updateMany({ where: { id: { in: [firstClaim.claimId, secondClaim.claimId] } }, data: { createdAt: tie } })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    })

    // With createdAt tied, the id tiebreak must deterministically keep the
    // lower-id claim (first) and drop the higher-id one (second) — the same
    // "oldest-first" intent createdAt alone can no longer express.
    expect('kept' in preview && preview.kept).toEqual([first.id])
    expect('dropped' in preview && preview.dropped.map((d) => d.userId)).toEqual([second.id])
  })

  it('MINOR-7: a partial requirements object still clears the untouched ShiftRequirement rows', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2, 1)
    // DOCTOR starts at 1, RECEPTIONIST at 0. The proposal below only mentions
    // NURSE — under the old Object.keys(...) approach, DOCTOR's row would be
    // left at 1 even though the caller's intent (a full replace) is 0.
    const partial = {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 2 } as unknown as Record<'NURSE' | 'DOCTOR' | 'RECEPTIONIST', number>,
    }
    const preview = await previewShiftEdit(db, shift.id, partial)
    await commitShiftEdit(db, shift.id, partial, await expectFromPreview(preview))

    const reqs = await db.shiftRequirement.findMany({ where: { shiftId: shift.id } })
    const byProfession = Object.fromEntries(reqs.map((r) => [r.profession, r.requiredCount]))
    expect(byProfession).toEqual({ NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 })
  })

  it('CRITICAL-2: a claim landing on the edited shift can never end up double-booked with another shift', async () => {
    const db = await getTestDb()

    // Repeat the race many times with fresh entities each time: the window
    // this closes is a genuine inter-statement race, not something a single
    // trial can reliably land in, so amplification is how the review itself
    // demonstrated it (and how this proves it stays closed).
    for (let i = 0; i < 25; i++) {
      const shift1 = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
      // shift2 overlaps shift1's PROPOSED time (21:00-05:00) but not its
      // current time — exactly the window CRITICAL-2 exploited.
      const shift2 = await makeShift(D('2026-12-01T22:00Z'), D('2026-12-02T02:00Z'), 2)
      const incumbent = await db.user.create({
        data: { email: `inc${i}@c.test`, name: `Incumbent ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
      const racer = await db.user.create({
        data: { email: `race${i}@c.test`, name: `Racer ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
      await assignClaim({ db, shiftId: shift1.id, userId: incumbent.id, actorId: incumbent.id })

      const proposed = { startsAt: D('2026-12-01T21:00Z'), endsAt: D('2026-12-02T05:00Z'), requirements: { ...REQ } }
      const preview = await previewShiftEdit(db, shift1.id, proposed)
      const expected = await expectFromPreview(preview)

      // Race: the edit retimes shift1 onto shift2's window, while the racer
      // simultaneously tries to claim shift1 (the shift being edited) AND
      // shift2 (the shift that will become its conflict).
      await Promise.all([
        commitShiftEdit(db, shift1.id, proposed, expected),
        assignClaim({ db, shiftId: shift1.id, userId: racer.id, actorId: racer.id }),
        assignClaim({ db, shiftId: shift2.id, userId: racer.id, actorId: racer.id }),
      ])

      const racerClaims = await db.claim.findMany({ where: { userId: racer.id }, include: { shift: true } })
      for (let a = 0; a < racerClaims.length; a++) {
        for (let b = a + 1; b < racerClaims.length; b++) {
          const x = racerClaims[a]!.shift
          const y = racerClaims[b]!.shift
          const overlapping = x.startsAt < y.endsAt && y.startsAt < x.endsAt
          expect(overlapping).toBe(false)
        }
      }
    }
  })
})

describe('previewShiftDelete', () => {
  it('lists current holders, not a dropped-claim rule violation (MINOR-9)', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const preview = await previewShiftDelete(db, shift.id)

    if (!('holders' in preview)) throw new Error(`expected a successful preview, got ${JSON.stringify(preview)}`)
    expect(preview.holders).toEqual([{ userId: nurse.id, name: 'Nurse 1', profession: 'NURSE' }])
    expect(preview.version).toBe(0)
    expect(typeof preview.claimsToken).toBe('string')
  })

  it('returns NOT_FOUND for a shift that no longer exists', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    await db.shift.delete({ where: { id: shift.id } })

    const preview = await previewShiftDelete(db, shift.id)
    expect('code' in preview && preview.code).toBe('NOT_FOUND')
  })
})

describe('commitShiftDelete', () => {
  it('deletes the shift and cascades its claims', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const preview = await previewShiftDelete(db, shift.id)
    const result = await commitShiftDelete(db, shift.id, await expectFromPreview(preview))

    expect('ok' in result && result.ok).toBe(true)
    expect(await db.shift.findUnique({ where: { id: shift.id } })).toBeNull()
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(0)
    expect(await db.eventOutbox.count({ where: { type: 'shift.deleted' } })).toBe(1)
  })

  it('refuses a stale confirm when a claim landed after the preview, even though the version never moved', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })

    const preview = await previewShiftDelete(db, shift.id)
    const stale = await expectFromPreview(preview)

    await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(stale.version)

    const result = await commitShiftDelete(db, shift.id, stale)

    expect('code' in result && result.code).toBe('VERSION_CONFLICT')
    expect(await db.shift.findUnique({ where: { id: shift.id } })).not.toBeNull()
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(2)
  })
})
