import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const session = vi.hoisted(() => ({
  user: null as null | { id: number; role: 'MANAGER' | 'STAFF'; profession: string | null; name: string; email: string },
}))

vi.mock('@/lib/auth/session', () => ({
  currentSessionUser: () =>
    Promise.resolve(
      session.user
        ? {
            authUserId: 'auth-uid',
            email: session.user.email,
            name: session.user.name,
            principal: { id: session.user.id, role: session.user.role, profession: session.user.profession },
          }
        : null,
    ),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

// The admin client is never constructed in unit tests — it would need a live
// GoTrue. Every route reaches it through this one factory, so stubbing here
// covers all four handlers.
const adminCalls = vi.hoisted(() => ({ invited: [] as string[], deleted: [] as string[], banned: [] as string[] }))
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: (email: string) => {
          adminCalls.invited.push(email)
          return Promise.resolve({ data: { user: { id: `uid-${adminCalls.invited.length}` } }, error: null })
        },
        updateUserById: (id: string, attrs: Record<string, unknown>) => {
          if ('ban_duration' in attrs) adminCalls.banned.push(id)
          return Promise.resolve({ data: { user: { id } }, error: null })
        },
        listUsers: () => Promise.resolve({ data: { users: [] }, error: null }),
        deleteUser: (id: string) => {
          adminCalls.deleted.push(id)
          return Promise.resolve({ error: null })
        },
      },
    },
  }),
}))

const { GET, POST } = await import('@/app/api/members/route')
const { DELETE: DEACTIVATE } = await import('@/app/api/members/[id]/route')

// Set in beforeEach to the real id of a persisted manager row, never
// hardcoded — `resetTestDb()` truncates with `RESTART IDENTITY`, so the first
// row any test creates also gets id 1. A hardcoded `session.user.id: 1` would
// collide with that first row by coincidence rather than by test intent,
// silently tripping the DELETE handler's self-deactivation guard.
let managerId = 0

beforeEach(async () => {
  await resetTestDb()
  adminCalls.invited.length = 0
  adminCalls.deleted.length = 0
  adminCalls.banned.length = 0
  const db = await getTestDb()
  const manager = await db.user.create({
    data: { email: 'dana@c.test', name: 'Dana', role: 'MANAGER', profession: null },
  })
  managerId = manager.id
  session.user = { id: manager.id, role: 'MANAGER', profession: null, name: 'Dana', email: 'dana@c.test' }
})
afterAll(stopTestDb)

function post(body: unknown) {
  return new Request('http://localhost/api/members', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

const VALID = { email: 'new@clinicmail.test', name: 'New Person', role: 'STAFF', profession: 'NURSE' }

describe('POST /api/members', () => {
  it('refuses a staff member with 403', async () => {
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(403)
  })

  it('refuses an unauthenticated request with 401', async () => {
    session.user = null
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('invites a new member for a manager', async () => {
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    expect(adminCalls.invited).toEqual(['new@clinicmail.test'])
  })

  it('rejects a staff invite with no profession as 400, not 500', async () => {
    const res = await POST(post({ ...VALID, profession: null }), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(adminCalls.invited).toHaveLength(0)
  })

  it('rejects a malformed email as 400', async () => {
    const res = await POST(post({ ...VALID, email: 'not-an-email' }), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/members', () => {
  it('refuses a staff member with 403', async () => {
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }
    const res = await GET(new Request('http://localhost/api/members'), { params: Promise.resolve({}) })
    expect(res.status).toBe(403)
  })

  it('lists every roster member with a derived status', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'imported@c.test', name: 'Imported', role: 'STAFF', profession: 'NURSE' },
    })
    const res = await GET(new Request('http://localhost/api/members'), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    const body = await res.json()
    const imported = body.members.find((m: { email: string }) => m.email === 'imported@c.test')
    expect(imported.status).toBe('no-account')
  })
})

describe('DELETE /api/members/[id]', () => {
  it('refuses a staff member with 403', async () => {
    const db = await getTestDb()
    const target = await db.user.create({
      data: { email: 't@c.test', name: 'T', role: 'STAFF', profession: 'NURSE' },
    })
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }

    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: String(target.id) }),
    })
    expect(res.status).toBe(403)
  })

  it('deactivates for a manager and reports released shifts', async () => {
    const db = await getTestDb()
    const target = await db.user.create({
      data: { email: 't@c.test', name: 'T', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-t' },
    })

    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: String(target.id) }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ releasedShiftIds: [] })
    expect(adminCalls.banned).toEqual(['uid-t'])
  })

  it('returns 400 for a non-numeric id rather than crashing', async () => {
    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'abc' }),
    })
    expect(res.status).toBe(400)
  })

  it('refuses to let a manager deactivate their own account, with 403', async () => {
    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: String(managerId) }),
    })
    expect(res.status).toBe(403)
    expect(adminCalls.banned).toHaveLength(0)
  })
})
