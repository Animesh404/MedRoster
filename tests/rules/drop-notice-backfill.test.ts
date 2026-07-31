import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

/**
 * The backfill half of the DropNotice migration, exercised against real events.
 *
 * This SQL runs exactly once against production and cannot be undone, so it
 * gets tested like code rather than eyeballed like a script. The tests read
 * the migration file itself — not a copy — so editing the migration without
 * re-checking its behaviour fails here rather than in production.
 *
 * `migrate deploy` has already run the real thing against an empty outbox by
 * the time these start, so each test seeds events and re-runs the INSERTs.
 */
const MIGRATION = 'prisma/migrations/20260731093236_drop_notice/migration.sql'

function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8')
  const backfill = sql.slice(sql.indexOf('-- Backfill from EventOutbox.'))
  const statements = backfill
    .split(/;\s*\n(?=\s*(?:--|INSERT))/)
    .map((s) => s.trim().replace(/;$/, ''))
    .filter((s) => /INSERT/i.test(s))
  // Guards against the file being restructured into something this splitter
  // silently reads as zero statements — which would make every test below
  // pass by asserting on an empty table.
  expect(statements).toHaveLength(2)
  return statements
}

async function runBackfill() {
  const db = await getTestDb()
  for (const stmt of backfillStatements()) await db.$executeRawUnsafe(stmt)
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

const RECENT = new Date(Date.now() - 60 * 60 * 1000)
const ANCIENT = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

async function seedNurse(email = 'n@c.test') {
  const db = await getTestDb()
  return db.user.create({
    data: { email, name: 'Nina', role: 'STAFF', profession: 'NURSE' },
  })
}

async function seedEvent(
  type: string, topic: string, payload: unknown, createdAt: Date,
) {
  const db = await getTestDb()
  return db.$executeRawUnsafe(
    `INSERT INTO "EventOutbox" (topic, type, payload, "createdAt") VALUES ($1, $2, $3::jsonb, $4)`,
    topic, type, JSON.stringify(payload), createdAt,
  )
}

describe('DropNotice backfill', () => {
  it('creates a notice for somebody dropped by a shift edit', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const shift = await db.shift.create({
      data: { startsAt: new Date('2026-09-01T09:00:00Z'), endsAt: new Date('2026-09-01T17:00:00Z') },
    })
    await seedEvent('shift.claims_dropped', 'week:2026-W36',
      { shiftId: shift.id, dropped: [{ userId: nurse.id, reason: 'No longer eligible.' }] }, RECENT)

    await runBackfill()

    const notices = await db.dropNotice.findMany()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ userId: nurse.id, shiftId: shift.id, kind: 'dropped', reason: 'No longer eligible.' })
    expect(notices[0]!.shiftStartsAt?.toISOString()).toBe('2026-09-01T09:00:00.000Z')
  })

  /**
   * The duplicate. Retiming a shift across a week boundary emits
   * `shift.claims_dropped` on BOTH weeks' topics with identical payloads —
   * the member lost the shift once and must be told once. Without the
   * DISTINCT ON this produces two identical banners.
   */
  it('writes one notice for a cross-week retime, not one per topic', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const shift = await db.shift.create({
      data: { startsAt: new Date('2026-09-08T09:00:00Z'), endsAt: new Date('2026-09-08T17:00:00Z') },
    })
    const payload = { shiftId: shift.id, dropped: [{ userId: nurse.id, reason: 'The shift moved.' }] }
    await seedEvent('shift.claims_dropped', 'week:2026-W36', payload, RECENT)
    await seedEvent('shift.claims_dropped', 'week:2026-W37', payload, RECENT)

    await runBackfill()

    expect(await db.dropNotice.count()).toBe(1)
  })

  /**
   * The gap that made query #1 different from query #2: a shift that was
   * retimed (dropping somebody) and LATER deleted has no Shift row to join
   * against, so a plain LEFT JOIN yields NULL times and the member is left a
   * bare shift number with no way to know which shift they lost.
   */
  it('recovers times from event history when the dropped shift was later deleted', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const goneShiftId = 4242
    await seedEvent('shift.created', 'week:2026-W36',
      { shiftId: goneShiftId, startsAt: '2026-09-02T07:00:00Z', endsAt: '2026-09-02T15:00:00Z' }, ANCIENT)
    await seedEvent('shift.edited', 'week:2026-W36',
      { shiftId: goneShiftId, startsAt: '2026-09-03T08:00:00Z', endsAt: '2026-09-03T16:00:00Z' }, RECENT)
    await seedEvent('shift.claims_dropped', 'week:2026-W36',
      { shiftId: goneShiftId, dropped: [{ userId: nurse.id, reason: 'The shift moved.' }] }, RECENT)

    await runBackfill()

    const notice = await db.dropNotice.findFirstOrThrow()
    // The LAST known time, not the original — shift.edited wins over shift.created.
    expect(notice.shiftStartsAt?.toISOString()).toBe('2026-09-03T08:00:00.000Z')
    expect(notice.shiftEndsAt?.toISOString()).toBe('2026-09-03T16:00:00.000Z')
  })

  it('recovers times for a deleted shift from its creation event alone', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const goneShiftId = 5150
    await seedEvent('shift.created', 'week:2026-W36',
      { shiftId: goneShiftId, startsAt: '2026-09-04T07:00:00Z', endsAt: '2026-09-04T15:00:00Z' }, RECENT)
    await seedEvent('shift.deleted', 'week:2026-W36',
      { shiftId: goneShiftId, affectedUserIds: [String(nurse.id)] }, RECENT)

    await runBackfill()

    const notice = await db.dropNotice.findFirstOrThrow()
    expect(notice.kind).toBe('deleted')
    // endsAt too — the original query only consulted shift.edited for the end
    // time, so a never-edited shift lost it.
    expect(notice.shiftStartsAt?.toISOString()).toBe('2026-09-04T07:00:00.000Z')
    expect(notice.shiftEndsAt?.toISOString()).toBe('2026-09-04T15:00:00.000Z')
  })

  /**
   * Bounded to the grace window. Backfilling the whole outbox would greet every
   * member who ever lost a shift with a wall of drops they dealt with months
   * ago — on the day of deploy, all at once.
   */
  it('ignores events older than the grace window', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    const shift = await db.shift.create({
      data: { startsAt: new Date('2026-09-01T09:00:00Z'), endsAt: new Date('2026-09-01T17:00:00Z') },
    })
    await seedEvent('shift.claims_dropped', 'week:2026-W36',
      { shiftId: shift.id, dropped: [{ userId: nurse.id, reason: 'Ancient history.' }] }, ANCIENT)
    await seedEvent('shift.deleted', 'week:2026-W36',
      { shiftId: 9999, affectedUserIds: [String(nurse.id)] }, ANCIENT)

    await runBackfill()

    expect(await db.dropNotice.count()).toBe(0)
  })

  // The FK is ON DELETE CASCADE, but the insert has to survive an event naming
  // somebody who has since been deleted outright — otherwise the whole
  // migration aborts and nobody gets a notice.
  it('skips events naming a user who no longer exists', async () => {
    const db = await getTestDb()
    await seedEvent('shift.claims_dropped', 'week:2026-W36',
      { shiftId: 1, dropped: [{ userId: 987_654, reason: 'Gone.' }] }, RECENT)
    await seedEvent('shift.deleted', 'week:2026-W36',
      { shiftId: 2, affectedUserIds: ['987654'] }, RECENT)

    await expect(runBackfill()).resolves.not.toThrow()
    expect(await db.dropNotice.count()).toBe(0)
  })

  it('gives every dropped member on one shift their own notice', async () => {
    const db = await getTestDb()
    const one = await seedNurse('one@c.test')
    const two = await seedNurse('two@c.test')
    const shift = await db.shift.create({
      data: { startsAt: new Date('2026-09-01T09:00:00Z'), endsAt: new Date('2026-09-01T17:00:00Z') },
    })
    await seedEvent('shift.claims_dropped', 'week:2026-W36', {
      shiftId: shift.id,
      dropped: [{ userId: one.id, reason: 'A.' }, { userId: two.id, reason: 'B.' }],
    }, RECENT)

    await runBackfill()

    const notices = await db.dropNotice.findMany({ orderBy: { userId: 'asc' } })
    expect(notices.map((n) => n.userId)).toEqual([one.id, two.id])
  })

  // A drop with no reason in the payload still has to produce a readable
  // banner rather than an empty one.
  it('falls back to a default reason when the event carries none', async () => {
    const db = await getTestDb()
    const nurse = await seedNurse()
    await seedEvent('shift.claims_dropped', 'week:2026-W36',
      { shiftId: 1, dropped: [{ userId: nurse.id }] }, RECENT)

    await runBackfill()

    expect((await db.dropNotice.findFirstOrThrow()).reason).toBe('You were removed from this shift.')
  })
})
