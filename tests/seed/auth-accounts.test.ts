import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureAuthAccounts, type AuthAdminPort } from '@/lib/seed/auth-accounts'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

/** In-memory stand-in for supabase.auth.admin. */
function fakeAdmin(seedUsers: { id: string; email: string }[] = []) {
  const users = [...seedUsers]
  let nextId = users.length + 1
  const calls = { created: [] as string[], updated: [] as string[] }

  const port: AuthAdminPort = {
    listUsers: () => Promise.resolve({ data: { users: users.map((u) => ({ ...u })) }, error: null }),
    createUser: (attrs) => {
      if (users.some((u) => u.email === attrs.email)) {
        return Promise.resolve({ data: { user: null }, error: { code: 'email_exists' } })
      }
      const user = { id: `uid-${nextId++}`, email: attrs.email }
      users.push(user)
      calls.created.push(attrs.email)
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

  it('leaves non-demo profiles without an account', async () => {
    const db = await seedProfiles()
    const { port } = fakeAdmin()

    await ensureAuthAccounts(db, port, { password: 'medroster123' })

    const other = await db.user.findUniqueOrThrow({ where: { email: 'nobody@clinicmail.test' } })
    expect(other.authUserId).toBeNull()
  })

  it('is idempotent — a second run creates nothing and relinks the same ids', async () => {
    const db = await seedProfiles()
    const { port } = fakeAdmin()

    const first = await ensureAuthAccounts(db, port, { password: 'medroster123' })
    const before = await db.user.findUniqueOrThrow({ where: { email: 'ivy.bell@clinicmail.test' } })

    const second = await ensureAuthAccounts(db, port, { password: 'medroster123' })
    const after = await db.user.findUniqueOrThrow({ where: { email: 'ivy.bell@clinicmail.test' } })

    expect(first.created).toBe(4)
    expect(second.created).toBe(0)
    expect(after.authUserId).toBe(before.authUserId)
  })

  it('adopts an auth user that already exists from a previous stack', async () => {
    const db = await seedProfiles()
    const { port } = fakeAdmin([{ id: 'pre-existing', email: 'manager@clinicmail.test' }])

    await ensureAuthAccounts(db, port, { password: 'medroster123' })

    const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager@clinicmail.test' } })
    expect(manager.authUserId).toBe('pre-existing')
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
