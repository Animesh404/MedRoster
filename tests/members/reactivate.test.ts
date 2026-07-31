import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deactivateMember, reactivateMember, type BanAdminPort } from '@/lib/members/deactivate'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')
const FUTURE = new Date('2026-08-10T09:00:00Z')

function fakeAdmin() {
  const calls: { id: string; duration: unknown }[] = []
  const port: BanAdminPort = {
    updateUserById: (id, attrs) => {
      calls.push({ id, duration: attrs.ban_duration })
      return Promise.resolve({ error: null })
    },
  }
  return { port, calls }
}

async function seedDeactivatedMemberWhoHeldAShift() {
  const db = await getTestDb()
  const nurse = await db.user.create({
    data: {
      email: 'returner@c.test', name: 'Returner', role: 'STAFF',
      profession: 'NURSE', authUserId: 'uid-returner',
    },
  })
  const shift = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: new Date('2026-08-10T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  await db.claim.create({ data: { shiftId: shift.id, userId: nurse.id } })

  const { port } = fakeAdmin()
  await deactivateMember(db, port, nurse.id, { now: NOW })

  return { db, nurse, shift }
}

describe('reactivateMember', () => {
  it('clears deactivatedAt so the roster gate lets them back in', async () => {
    const { db, nurse } = await seedDeactivatedMemberWhoHeldAShift()
    const { port } = fakeAdmin()

    const result = await reactivateMember(db, port, nurse.id)

    expect(result).toEqual({ ok: true })
    const profile = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    expect(profile.deactivatedAt).toBeNull()
  })

  // Deactivation bans for 100 years (Supabase has no "forever"), so clearing
  // the profile flag alone would leave them locked out at the auth layer with
  // a roster that says they are fine — the two stores disagreeing silently.
  it('lifts the Supabase ban, not just the profile flag', async () => {
    const { db, nurse } = await seedDeactivatedMemberWhoHeldAShift()
    const { port, calls } = fakeAdmin()

    await reactivateMember(db, port, nurse.id)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('uid-returner')
    expect(calls[0]!.duration).toBe('none')
  })

  // The deliberate asymmetry. Deactivation released their future shifts and
  // someone else may have picked them up since; handing them back on return
  // would silently oversell the shift and countermand a colleague's claim.
  it('does not restore the claims that deactivation released', async () => {
    const { db, nurse, shift } = await seedDeactivatedMemberWhoHeldAShift()
    const { port } = fakeAdmin()

    await reactivateMember(db, port, nurse.id)

    expect(await db.claim.count({ where: { shiftId: shift.id, userId: nurse.id } })).toBe(0)
  })

  it('emits no roster events — nothing about staffing changed', async () => {
    const { db, nurse } = await seedDeactivatedMemberWhoHeldAShift()
    const before = await db.eventOutbox.count()
    const { port } = fakeAdmin()

    await reactivateMember(db, port, nurse.id)

    expect(await db.eventOutbox.count()).toBe(before)
  })

  it('is idempotent — reactivating an active member changes nothing', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: {
        email: 'active@c.test', name: 'Active', role: 'STAFF',
        profession: 'NURSE', authUserId: 'uid-active',
      },
    })
    const { port, calls } = fakeAdmin()

    const result = await reactivateMember(db, port, nurse.id)

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.id } })).deactivatedAt).toBeNull()
  })

  // A member deactivated before they ever accepted an invite has no Supabase
  // user to unban; clearing the profile flag is the whole job.
  it('reactivates an account-less profile without calling the admin API', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: {
        email: 'never@c.test', name: 'Never Invited', role: 'STAFF',
        profession: 'NURSE', deactivatedAt: new Date('2026-01-01'),
      },
    })
    const { port, calls } = fakeAdmin()

    const result = await reactivateMember(db, port, nurse.id)

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.id } })).deactivatedAt).toBeNull()
  })

  it('refuses somebody who is not on the roster', async () => {
    const db = await getTestDb()
    const { port } = fakeAdmin()

    expect(await reactivateMember(db, port, 999_999)).toMatchObject({ code: 'NOT_FOUND' })
  })

  // Fail closed: if the unban fails, the profile must stay deactivated rather
  // than claiming a member is back when they still cannot sign in.
  it('leaves the profile deactivated if the unban fails', async () => {
    const { db, nurse } = await seedDeactivatedMemberWhoHeldAShift()
    const port: BanAdminPort = {
      updateUserById: () => Promise.resolve({ error: { message: 'service unavailable' } }),
    }

    const result = await reactivateMember(db, port, nurse.id)

    expect(result).toMatchObject({ code: 'INVALID_INPUT' })
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.id } })).deactivatedAt).toBeInstanceOf(Date)
  })

  it('lets a reactivated member claim shifts again', async () => {
    const { db, nurse } = await seedDeactivatedMemberWhoHeldAShift()
    const { port } = fakeAdmin()
    await reactivateMember(db, port, nurse.id)

    const fresh = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-01T09:00:00Z'), endsAt: new Date('2026-09-01T17:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    const { assignClaim } = await import('@/lib/rules/assign')
    const result = await assignClaim({ db, shiftId: fresh.id, userId: nurse.id, actorId: nurse.id })

    expect(result).toMatchObject({ claimId: expect.any(Number) })
  })
})
