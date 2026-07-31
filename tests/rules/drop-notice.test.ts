import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { activeDropNotices, dismissDropNotice, NOTICE_GRACE_MS } from '@/lib/rules/drop-notice'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')
const FUTURE = new Date('2026-08-20T09:00:00Z')
const PAST = new Date('2026-07-20T09:00:00Z')

async function seedNurse() {
  const db = await getTestDb()
  return db.user.create({
    data: { email: 'n@c.test', name: 'Nina', role: 'STAFF', profession: 'NURSE' },
  })
}

async function seedNotice(
  userId: number,
  over: Partial<{
    shiftStartsAt: Date | null; dismissedAt: Date | null; shiftId: number; createdAt: Date
  }> = {},
) {
  const db = await getTestDb()
  return db.dropNotice.create({
    data: {
      userId, shiftId: over.shiftId ?? 1, kind: 'dropped',
      reason: 'A manager edited this shift.',
      shiftStartsAt: over.shiftStartsAt === undefined ? FUTURE : over.shiftStartsAt,
      shiftEndsAt: null,
      dismissedAt: over.dismissedAt ?? null,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  })
}

describe('activeDropNotices', () => {
  it('returns a notice for a shift still ahead of the member', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id)

    const notices = await activeDropNotices(db, nurse.id, { now: NOW })

    expect(notices).toHaveLength(1)
    expect(notices[0]!.reason).toBe('A manager edited this shift.')
  })

  // Dismissal is the acknowledgement. Without it a nurse dropped from a shift
  // four weeks out stares at the same banner for four weeks.
  it('hides a notice the member has dismissed', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, { dismissedAt: new Date('2026-08-01T09:00:00Z') })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  // Expiry is shiftStartsAt + grace, not "the shift has started". A notice
  // about a shift that began an hour ago is still worth reading — the nurse
  // needs to know they were not expected, not merely to plan around it.
  it('keeps showing a notice whose shift started recently', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, {
      shiftStartsAt: new Date(NOW.getTime() - 60 * 60 * 1000), createdAt: NOW,
    })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toHaveLength(1)
  })

  it('hides a notice once both the shift and the notice are past grace', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const longAgo = new Date(NOW.getTime() - NOTICE_GRACE_MS - 60 * 60 * 1000)
    await seedNotice(nurse.id, { shiftStartsAt: longAgo, createdAt: longAgo })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  // The born-invisible case. Deleting a shift that ALREADY started writes a
  // notice whose shift time is in the past — under a plain "has it started"
  // rule it would be filtered out the instant it existed, and the nurse would
  // never see it at all.
  it('shows a notice written now about a shift that already started', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, { shiftStartsAt: PAST, createdAt: NOW })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toHaveLength(1)
  })

  // A deleted shift whose times could not be recovered: no start to reason
  // from, so the createdAt floor is what keeps it visible.
  it('keeps showing a recent notice whose shift time is unknown', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, { shiftStartsAt: null, createdAt: NOW })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toHaveLength(1)
  })

  it('eventually expires a timeless notice rather than showing it forever', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, {
      shiftStartsAt: null,
      createdAt: new Date(NOW.getTime() - NOTICE_GRACE_MS - 60 * 60 * 1000),
    })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  it('never returns another member’s notices', async () => {
    const db = await getTestDb()
    const mine = await seedNurse()
    const theirs = await db.user.create({
      data: { email: 'other@c.test', name: 'Other', role: 'STAFF', profession: 'NURSE' },
    })
    await seedNotice(theirs.id)

    expect(await activeDropNotices(db, mine.id, { now: NOW })).toEqual([])
  })

  it('returns newest first', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const older = await seedNotice(nurse.id, { shiftId: 1 })
    const newer = await seedNotice(nurse.id, { shiftId: 2 })

    const notices = await activeDropNotices(db, nurse.id, { now: NOW })

    expect(notices.map((n) => n.id)).toEqual([newer.id, older.id])
  })
})

describe('dismissDropNotice', () => {
  it('dismisses the member’s own notice', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const notice = await seedNotice(nurse.id)

    const result = await dismissDropNotice(db, nurse.id, notice.id, { now: NOW })

    expect(result).toEqual({ ok: true })
    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  // The id comes from the client, so ownership has to be enforced server-side —
  // otherwise anyone could clear anyone else's notice by guessing an integer.
  it('refuses to dismiss somebody else’s notice, and leaves it showing', async () => {
    const db = await getTestDb()
    const mine = await seedNurse()
    const theirs = await db.user.create({
      data: { email: 'other@c.test', name: 'Other', role: 'STAFF', profession: 'NURSE' },
    })
    const notice = await seedNotice(theirs.id)

    const result = await dismissDropNotice(db, mine.id, notice.id, { now: NOW })

    expect(result).toMatchObject({ code: 'NOT_FOUND' })
    expect(await activeDropNotices(db, theirs.id, { now: NOW })).toHaveLength(1)
  })

  it('is idempotent — dismissing twice keeps the first timestamp', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const notice = await seedNotice(nurse.id)

    await dismissDropNotice(db, nurse.id, notice.id, { now: NOW })
    const first = await db.dropNotice.findUniqueOrThrow({ where: { id: notice.id } })
    await dismissDropNotice(db, nurse.id, notice.id, { now: new Date('2026-08-02T12:00:00Z') })
    const second = await db.dropNotice.findUniqueOrThrow({ where: { id: notice.id } })

    expect(second.dismissedAt!.getTime()).toBe(first.dismissedAt!.getTime())
  })

  it('reports a notice that does not exist', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()

    expect(await dismissDropNotice(db, nurse.id, 999_999, { now: NOW })).toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

/**
 * The fourth drop path, and the one that hid: a manager removing somebody from
 * a shift via `DELETE /api/shifts/[id]/claims/[userId]`.
 *
 * It shares `unassignClaim` with self-release, which is exactly why it was
 * missed — the function had no way to tell "I gave this up" from "somebody took
 * it off me". Only the second deserves a notice; telling a nurse they were
 * "removed" from a shift they released themselves would be worse than silence.
 */
describe('drop notices from a manager removing a claim', () => {
  async function seedShiftAndNurse() {
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: FUTURE, endsAt: new Date('2026-08-20T17:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
      },
    })
    const nurse = await seedNurse()
    const manager = await db.user.create({
      data: { email: 'mgr@c.test', name: 'Dana', role: 'MANAGER', profession: null },
    })
    await db.claim.create({ data: { shiftId: shift.id, userId: nurse.id } })
    return { db, shift, nurse, manager }
  }

  it('writes a notice when a manager removes somebody else', async () => {
    const { db, shift, nurse, manager } = await seedShiftAndNurse()
    const { unassignClaim } = await import('@/lib/rules/assign')

    await unassignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: manager.id })

    const notices = await activeDropNotices(db, nurse.id, { now: NOW })
    expect(notices).toHaveLength(1)
    expect(notices[0]!.kind).toBe('dropped')
    expect(notices[0]!.shiftId).toBe(shift.id)
    // The shift's real time, snapshotted — the notice has to say WHICH shift.
    expect(notices[0]!.shiftStartsAt?.toISOString()).toBe(FUTURE.toISOString())
  })

  it('writes NO notice when somebody releases their own shift', async () => {
    const { db, shift, nurse } = await seedShiftAndNurse()
    const { unassignClaim } = await import('@/lib/rules/assign')

    await unassignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  // The seeder and internal callers pass no actor. Treating "unknown" as
  // "somebody else did it" would spam notices for every seeded release.
  it('writes no notice when no actor is given', async () => {
    const { db, shift, nurse } = await seedShiftAndNurse()
    const { unassignClaim } = await import('@/lib/rules/assign')

    await unassignClaim({ db, shiftId: shift.id, userId: nurse.id })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })
})

/**
 * Re-claiming the shift. The notice says "you were removed from this shift" —
 * once they hold it again that is simply false, and leaving it up puts a
 * removal banner above a shift sitting in their own upcoming list.
 */
describe('drop notices when a shift is claimed again', () => {
  it('dismisses an outstanding notice for that shift', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const shift = await db.shift.create({
      data: {
        startsAt: FUTURE, endsAt: new Date('2026-08-20T17:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    await seedNotice(nurse.id, { shiftId: shift.id })
    const { assignClaim } = await import('@/lib/rules/assign')

    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
    // Dismissed, not deleted — the record that they were told survives.
    expect(await db.dropNotice.count()).toBe(1)
  })

  it('leaves notices for OTHER shifts alone', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const shift = await db.shift.create({
      data: {
        startsAt: FUTURE, endsAt: new Date('2026-08-20T17:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    await seedNotice(nurse.id, { shiftId: shift.id })
    await seedNotice(nurse.id, { shiftId: shift.id + 500 })
    const { assignClaim } = await import('@/lib/rules/assign')

    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const left = await activeDropNotices(db, nurse.id, { now: NOW })
    expect(left).toHaveLength(1)
    expect(left[0]!.shiftId).toBe(shift.id + 500)
  })
})
