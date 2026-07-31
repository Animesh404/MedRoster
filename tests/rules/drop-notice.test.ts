import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { activeDropNotices, dismissDropNotice } from '@/lib/rules/drop-notice'
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
  over: Partial<{ shiftStartsAt: Date | null; dismissedAt: Date | null; shiftId: number }> = {},
) {
  const db = await getTestDb()
  return db.dropNotice.create({
    data: {
      userId, shiftId: over.shiftId ?? 1, kind: 'dropped',
      reason: 'A manager edited this shift.',
      shiftStartsAt: over.shiftStartsAt === undefined ? FUTURE : over.shiftStartsAt,
      shiftEndsAt: null,
      dismissedAt: over.dismissedAt ?? null,
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

  // Auto-expiry, so an unread notice cannot accumulate forever. Once the shift
  // has started there is nothing left to act on.
  it('hides a notice whose shift has already started', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, { shiftStartsAt: PAST })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toEqual([])
  })

  // A deleted shift whose times could not be recovered. Hiding it on a null
  // would silently drop the notice entirely — the failure this table exists to
  // prevent — so an unknown time keeps showing.
  it('keeps showing a notice whose shift time is unknown', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedNotice(nurse.id, { shiftStartsAt: null })

    expect(await activeDropNotices(db, nurse.id, { now: NOW })).toHaveLength(1)
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
