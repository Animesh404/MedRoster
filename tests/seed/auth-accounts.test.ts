import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureAuthAccounts, type AuthAdminPort } from '@/lib/seed/auth-accounts'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

type CreateUserAttrs = Parameters<AuthAdminPort['createUser']>[0]

/**
 * In-memory stand-in for supabase.auth.admin.
 *
 * `calls.created` records the full `createUser` attrs for every invocation
 * (not just the email, and not just successful ones) so tests can assert on
 * the security-relevant shape of the call — app_metadata vs. user_metadata —
 * and can prove createUser was never *called* on a re-seed, rather than only
 * observing the returned counts.
 */
function fakeAdmin(seedUsers: { id: string; email: string }[] = []) {
  const users = [...seedUsers]
  let nextId = users.length + 1
  const calls = { created: [] as CreateUserAttrs[], updated: [] as string[] }

  const port: AuthAdminPort = {
    listUsers: () => Promise.resolve({ data: { users: users.map((u) => ({ ...u })) }, error: null }),
    createUser: (attrs) => {
      calls.created.push(attrs)
      if (users.some((u) => u.email === attrs.email)) {
        return Promise.resolve({ data: { user: null }, error: { code: 'email_exists' } })
      }
      const user = { id: `uid-${nextId++}`, email: attrs.email }
      users.push(user)
      return Promise.resolve({ data: { user }, error: null })
    },
    updateUserById: (id, _attrs) => {
      calls.updated.push(id)
      const user = users.find((u) => u.id === id)!
      return Promise.resolve({ data: { user }, error: null })
    },
  }
  return { port, calls }
}

/**
 * Simulates losing a race: another process creates `raceEmail` in Supabase
 * after this module's initial `listUsers()` snapshot was already taken, so
 * `createUser` comes back with `email_exists` for an address the snapshot
 * said was free. Exercises the recovery branch in `ensureAuthAccounts` — the
 * regular `fakeAdmin` above can only reach the `if (authUserId)` adopt path,
 * because it seeds the pre-existing user into the very first `listUsers()`
 * call.
 */
function raceAdmin(raceId: string, raceEmail: string) {
  let listCalls = 0
  let nextId = 100
  const calls = { created: [] as CreateUserAttrs[], updated: [] as string[] }

  const port: AuthAdminPort = {
    listUsers: () => {
      listCalls += 1
      // First call is the initial snapshot, taken before the race lands —
      // it must not see raceEmail yet. Every later (recovery) call reflects
      // the real, post-race state.
      const users = listCalls === 1 ? [] : [{ id: raceId, email: raceEmail }]
      return Promise.resolve({ data: { users }, error: null })
    },
    createUser: (attrs) => {
      calls.created.push(attrs)
      if (attrs.email === raceEmail) {
        return Promise.resolve({ data: { user: null }, error: { code: 'email_exists' } })
      }
      const user = { id: `uid-${nextId++}`, email: attrs.email }
      return Promise.resolve({ data: { user }, error: null })
    },
    updateUserById: (id, _attrs) => {
      calls.updated.push(id)
      return Promise.resolve({ data: { user: { id } }, error: null })
    },
  }
  return { port, calls }
}

async function seedProfiles() {
  const db = await getTestDb()
  await db.user.createMany({
    data: [
      { email: 'manager@clinicmail.test', name: 'Dana Okonkwo', role: 'MANAGER', profession: null, passwordHash: 'x' },
      { email: 'chloe.hussain@clinicmail.test', name: 'Chloe Hussain', role: 'STAFF', profession: 'DOCTOR', passwordHash: 'x' },
      { email: 'ivy.bell@clinicmail.test', name: 'Ivy Bell', role: 'STAFF', profession: 'NURSE', passwordHash: 'x' },
      { email: 'hiro.petrova@clinicmail.test', name: 'Hiro Petrova', role: 'STAFF', profession: 'RECEPTIONIST', passwordHash: 'x' },
      { email: 'nobody@clinicmail.test', name: 'Not A Demo', role: 'STAFF', profession: 'NURSE', passwordHash: 'x' },
    ],
  })
  return db
}

describe('ensureAuthAccounts', () => {
  it('creates an auth user for each demo account and links it to the profile', async () => {
    const db = await seedProfiles()
    const { port, calls } = fakeAdmin()

    const result = await ensureAuthAccounts(db, port, { password: 'medroster123' })

    expect(result.created).toBe(4)
    expect(calls.created).toHaveLength(4)
    const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager@clinicmail.test' } })
    expect(manager.authUserId).toMatch(/^uid-/)
  })

  it('puts role and profession in app_metadata, never user_metadata — user_metadata is user-writable', async () => {
    const db = await seedProfiles()
    const { port, calls } = fakeAdmin()

    await ensureAuthAccounts(db, port, { password: 'medroster123' })

    const byEmail = new Map(calls.created.map((c) => [c.email, c]))
    expect(byEmail.get('manager@clinicmail.test')).toMatchObject({
      password: 'medroster123',
      email_confirm: true,
      app_metadata: { role: 'MANAGER', profession: null },
    })
    expect(byEmail.get('chloe.hussain@clinicmail.test')?.app_metadata).toEqual({
      role: 'STAFF',
      profession: 'DOCTOR',
    })
    expect(byEmail.get('ivy.bell@clinicmail.test')?.app_metadata).toEqual({
      role: 'STAFF',
      profession: 'NURSE',
    })
    expect(byEmail.get('hiro.petrova@clinicmail.test')?.app_metadata).toEqual({
      role: 'STAFF',
      profession: 'RECEPTIONIST',
    })
    for (const attrs of calls.created) {
      expect(attrs).not.toHaveProperty('user_metadata')
    }
  })

  it('leaves non-demo profiles without an account', async () => {
    const db = await seedProfiles()
    const { port } = fakeAdmin()

    await ensureAuthAccounts(db, port, { password: 'medroster123' })

    const other = await db.user.findUniqueOrThrow({ where: { email: 'nobody@clinicmail.test' } })
    expect(other.authUserId).toBeNull()
  })

  it('is idempotent — a second run creates nothing and relinks the same ids', async () => {
    const db = await seedProfiles()
    const { port, calls } = fakeAdmin()

    const first = await ensureAuthAccounts(db, port, { password: 'medroster123' })
    const before = await db.user.findUniqueOrThrow({ where: { email: 'ivy.bell@clinicmail.test' } })
    const createUserCallsAfterFirstRun = calls.created.length

    const second = await ensureAuthAccounts(db, port, { password: 'medroster123' })
    const after = await db.user.findUniqueOrThrow({ where: { email: 'ivy.bell@clinicmail.test' } })

    expect(first.created).toBe(4)
    expect(second.created).toBe(0)
    // Proves createUser itself was never invoked on the second run — the
    // returned count alone wouldn't catch a naive always-call implementation
    // that happens to reach zero net creates via the email_exists recovery
    // path instead of skipping the call outright.
    expect(calls.created).toHaveLength(createUserCallsAfterFirstRun)
    expect(after.authUserId).toBe(before.authUserId)
  })

  it('adopts an auth user that already exists from a previous stack', async () => {
    const db = await seedProfiles()
    const { port } = fakeAdmin([{ id: 'pre-existing', email: 'manager@clinicmail.test' }])

    await ensureAuthAccounts(db, port, { password: 'medroster123' })

    const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager@clinicmail.test' } })
    expect(manager.authUserId).toBe('pre-existing')
  })

  it('adopts a user created by a concurrent process after createUser loses the race', async () => {
    const db = await seedProfiles()
    const { port, calls } = raceAdmin('raced-id', 'manager@clinicmail.test')

    const result = await ensureAuthAccounts(db, port, { password: 'medroster123' })

    // manager lost the race and was adopted via recovery; the other three
    // demo accounts were genuinely free and created normally.
    expect(result.created).toBe(3)
    expect(result.updated).toBe(1)
    expect(calls.created.some((c) => c.email === 'manager@clinicmail.test')).toBe(true)
    const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager@clinicmail.test' } })
    expect(manager.authUserId).toBe('raced-id')
  })

  it('skips a demo email with no profile rather than throwing', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'manager@clinicmail.test', name: 'Dana', role: 'MANAGER', profession: null, passwordHash: 'x' },
    })
    const { port } = fakeAdmin()

    const result = await ensureAuthAccounts(db, port, { password: 'medroster123' })
    expect(result.created).toBe(1)
  })
})
