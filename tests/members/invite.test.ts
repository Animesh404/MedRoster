import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { inviteMember, resendInvite, revokeInvite, type InviteAdminPort } from '@/lib/members/invite'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const REDIRECT = 'http://localhost:3000/auth/accept-invite'

// `options` is typed as `| undefined` rather than optional (`?:`) because the
// project's tsconfig sets `exactOptionalPropertyTypes: true`, and
// `inviteUserByEmail`'s `options` parameter can genuinely be `undefined` —
// an optional property can't accept an explicit `undefined` assignment under
// that flag.
type CreatedCall = { email: string; options: { redirectTo?: string } | undefined }

function fakeAdmin(seed: { id: string; email: string }[] = []) {
  const users = [...seed]
  let next = seed.length + 1
  const calls = {
    invited: [] as CreatedCall[],
    updated: [] as { id: string; attrs: Record<string, unknown> }[],
    deleted: [] as string[],
  }

  const port: InviteAdminPort = {
    inviteUserByEmail: (email, options) => {
      calls.invited.push({ email, options })
      if (users.some((u) => u.email === email)) {
        return Promise.resolve({ data: { user: null }, error: { code: 'email_exists' } })
      }
      const user = { id: `uid-${next++}`, email }
      users.push(user)
      return Promise.resolve({ data: { user }, error: null })
    },
    updateUserById: (id, attrs) => {
      calls.updated.push({ id, attrs })
      return Promise.resolve({ data: { user: { id } }, error: null })
    },
    listUsers: () => Promise.resolve({ data: { users: users.map((u) => ({ ...u })) }, error: null }),
    deleteUser: (id) => {
      calls.deleted.push(id)
      const i = users.findIndex((u) => u.id === id)
      if (i >= 0) users.splice(i, 1)
      return Promise.resolve({ error: null })
    },
  }
  return { port, calls }
}

const NURSE = {
  email: 'new.nurse@clinicmail.test', name: 'Nadia Nurse',
  role: 'STAFF' as const, profession: 'NURSE' as const, redirectTo: REDIRECT,
}

describe('inviteMember', () => {
  it('creates the auth user, sends the invite, and links a new profile', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ userId: expect.any(Number) })
    expect(calls.invited).toHaveLength(1)
    expect(calls.invited[0]!.options?.redirectTo).toBe(REDIRECT)

    const profile = await db.user.findUniqueOrThrow({ where: { email: NURSE.email } })
    expect(profile.authUserId).toBe('uid-1')
    expect(profile.role).toBe('STAFF')
    expect(profile.profession).toBe('NURSE')
  })

  // The security property: role must land where the user cannot rewrite it.
  it('writes role and profession to app_metadata, never user_metadata', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()

    await inviteMember(db, port, NURSE)

    expect(calls.updated).toHaveLength(1)
    expect(calls.updated[0]!.attrs).toEqual({
      app_metadata: { role: 'STAFF', profession: 'NURSE' },
    })
    expect(calls.updated[0]!.attrs).not.toHaveProperty('user_metadata')
    // And the invite call itself must not smuggle the role in via its `data`
    // option, which writes user_metadata. Without this, an implementation that
    // writes the role to BOTH stores passes every other assertion here.
    expect(calls.invited[0]!.options).not.toHaveProperty('data')
  })

  // The whole reason authUserId is nullable: staff.csv created 31 of these.
  it('adopts an existing account-less profile instead of creating a duplicate', async () => {
    const db = await getTestDb()
    const existing = await db.user.create({
      data: { email: NURSE.email, name: 'Imported Name', role: 'STAFF', profession: 'NURSE' },
    })
    const { port } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ userId: existing.id })
    expect(await db.user.count({ where: { email: NURSE.email } })).toBe(1)
    const profile = await db.user.findUniqueOrThrow({ where: { id: existing.id } })
    expect(profile.authUserId).toBe('uid-1')
  })

  it('refuses to re-invite somebody who already has an account', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: NURSE.email, name: 'Already In', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-existing' },
    })
    const { port, calls } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ code: 'ALREADY_CLAIMED' })
    expect(calls.invited).toHaveLength(0)
  })

  // Failing after the auth user exists would leave an orphan that can sign in
  // with no profile — currentSessionUser() returns null for it, so the person
  // gets a login that bounces them straight back out with no explanation.
  it('deletes the auth user if profile linking fails, leaving no orphan', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    // A second profile already owns this authUserId, so the unique index on
    // authUserId will reject the link.
    await db.user.create({
      data: { email: 'squatter@c.test', name: 'Squatter', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-1' },
    })

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ code: 'INVALID_INPUT' })
    expect(calls.deleted).toEqual(['uid-1'])
  })
})

describe('resendInvite', () => {
  it('re-issues the email without creating a second profile', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    const { userId } = (await inviteMember(db, port, NURSE)) as { userId: number }

    const result = await resendInvite(db, port, userId, REDIRECT)

    expect(result).toEqual({ ok: true })
    expect(calls.invited).toHaveLength(2)
    expect(await db.user.count({ where: { email: NURSE.email } })).toBe(1)
  })

  it('refuses to resend to a member with no account', async () => {
    const db = await getTestDb()
    const profile = await db.user.create({
      data: { email: 'nobody@c.test', name: 'Nobody', role: 'STAFF', profession: 'NURSE' },
    })
    const { port } = fakeAdmin()

    expect(await resendInvite(db, port, profile.id, REDIRECT)).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('revokeInvite', () => {
  it('deletes the auth user and unlinks the profile, keeping the roster row', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    const { userId } = (await inviteMember(db, port, NURSE)) as { userId: number }

    const result = await revokeInvite(db, port, userId)

    expect(result).toEqual({ ok: true })
    expect(calls.deleted).toEqual(['uid-1'])
    const profile = await db.user.findUniqueOrThrow({ where: { id: userId } })
    // The person stays on the roster and can be re-invited; only the pending
    // account is withdrawn.
    expect(profile.authUserId).toBeNull()
  })
})
