import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deactivateMember, type BanAdminPort } from '@/lib/members/deactivate'
import { weekTopic } from '@/lib/events/topics'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')
const FUTURE = new Date('2026-08-10T09:00:00Z')
const PAST = new Date('2026-07-20T09:00:00Z')

function fakeAdmin() {
  const banned: { id: string; duration: unknown }[] = []
  const port: BanAdminPort = {
    updateUserById: (id, attrs) => {
      banned.push({ id, duration: attrs.ban_duration })
      return Promise.resolve({ error: null })
    },
  }
  return { port, banned }
}

async function seedMemberWithClaims() {
  const db = await getTestDb()
  const nurse = await db.user.create({
    data: { email: 'leaver@c.test', name: 'Leaver', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-leaver' },
  })
  const future = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: new Date('2026-08-10T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  const past = await db.shift.create({
    data: {
      startsAt: PAST, endsAt: new Date('2026-07-20T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  await db.claim.createMany({
    data: [
      { shiftId: future.id, userId: nurse.id },
      { shiftId: past.id, userId: nurse.id },
    ],
  })
  return { db, nurse, future, past }
}

describe('deactivateMember', () => {
  it('releases claims on shifts that have not started', async () => {
    const { db, nurse, future } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [future.id] })
    expect(await db.claim.count({ where: { shiftId: future.id, userId: nurse.id } })).toBe(0)
  })

  // History, not staffing. Deleting it would rewrite who worked a shift that
  // has already happened.
  it('keeps claims on shifts that have already started', async () => {
    const { db, nurse, past } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(await db.claim.count({ where: { shiftId: past.id, userId: nurse.id } })).toBe(1)
  })

  it('marks the profile deactivated and bans the Supabase user', async () => {
    const { db, nurse } = await seedMemberWithClaims()
    const { port, banned } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    const profile = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    expect(profile.deactivatedAt).toBeInstanceOf(Date)
    expect(banned).toHaveLength(1)
    expect(banned[0]!.id).toBe('uid-leaver')
  })

  // Without these, every open dashboard keeps showing the released slot as
  // filled until someone reloads — the exact thing realtime exists to prevent.
  // Asserted structurally, NOT with `JSON.stringify(...).toContain(id)`. That
  // shortcut cannot tell shiftId from userId (both are small integers from a
  // fresh container, so the digits collide), cannot see the topic at all, and
  // cannot see whether the payload matches the shape the UI actually reads.
  it('emits a claims_dropped event carrying the shape both consumers read', async () => {
    const { db, nurse, future } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    const events = await db.eventOutbox.findMany({ where: { type: 'shift.claims_dropped' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      // Subscribers listen per week. Emitting on the CURRENT week rather than
      // the shift's would deliver into a topic nobody viewing that shift is
      // subscribed to — the event would vanish silently.
      topic: weekTopic(FUTURE),
      payload: {
        shiftId: future.id,
        dropped: [{
          userId: nurse.id,
          // `name` and `reason` are not decoration: app/(app)/shifts/[id]/page.tsx
          // renders `${d.name} was dropped — ${d.reason}` and my-shifts reads
          // `d.reason`. Omitting them renders "undefined was dropped — undefined".
          name: 'Leaver',
          profession: 'NURSE',
          code: 'NOT_CLAIMED',
          // Exact match, not a loose pattern: this string is user-facing (it
          // renders verbatim at the two sites above), so pinning it exactly
          // means an accidental reword shows up as a test failure instead of
          // silently changing what staff read on the shift board.
          reason: 'They were removed from the roster.',
        }],
      },
    })
  })

  it('emits no event when the member held no future shifts', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'idle@c.test', name: 'Idle', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-idle' },
    })
    const { port } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [] })
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(0)
  })

  it('is idempotent — deactivating twice changes nothing the second time', async () => {
    const { db, nurse } = await seedMemberWithClaims()
    const { port, banned } = fakeAdmin()

    const first = await deactivateMember(db, port, nurse.id, { now: NOW })
    const before = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    const second = await deactivateMember(db, port, nurse.id, { now: NOW })
    const after = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })

    expect(first).toMatchObject({ releasedShiftIds: expect.any(Array) })
    expect(second).toMatchObject({ releasedShiftIds: [] })
    expect(after.deactivatedAt!.getTime()).toBe(before.deactivatedAt!.getTime())
    // Pinned, not incidental: the second call short-circuits on the
    // already-deactivated profile before it ever reaches the admin API, so
    // a repeat deactivation does not re-ban an already-banned account.
    expect(banned).toHaveLength(1)
  })
  // NOTE: the above is sequential — it awaits the first call to completion
  // before starting the second, so it only proves ordinary re-invocation is
  // safe. The genuinely concurrent case (two overlapping calls racing under
  // READ COMMITTED) is covered separately in
  // tests/concurrency/deactivate.test.ts, which also asserts no duplicate
  // shift.claims_dropped event and no double-release of the claim.

  it('refuses to deactivate somebody who does not exist', async () => {
    const db = await getTestDb()
    const { port } = fakeAdmin()
    expect(await deactivateMember(db, port, 999_999, { now: NOW })).toMatchObject({ code: 'NOT_FOUND' })
  })

  // A member invited but never accepted has no Supabase session to kill; the
  // profile mark alone is the whole job.
  it('deactivates an account-less profile without calling the admin API', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'never@c.test', name: 'Never Invited', role: 'STAFF', profession: 'NURSE' },
    })
    const { port, banned } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [] })
    expect(banned).toHaveLength(0)
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.id } })).deactivatedAt).toBeInstanceOf(Date)
  })
})
