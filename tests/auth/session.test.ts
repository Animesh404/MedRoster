import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const authUser = vi.hoisted(() => ({ current: null as { id: string } | null }))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: {
        getUser: () =>
          Promise.resolve(
            authUser.current
              ? { data: { user: authUser.current }, error: null }
              : { data: { user: null }, error: new Error('no session') },
          ),
      },
    }),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { currentSessionUser } = await import('@/lib/auth/session')

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('currentSessionUser', () => {
  it('returns null when there is no Supabase session', async () => {
    authUser.current = null
    expect(await currentSessionUser()).toBeNull()
  })

  it('resolves the profile and builds a Principal from it', async () => {
    const db = await getTestDb()
    const profile = await db.user.create({
      data: {
        email: 'nurse@c.test', name: 'Nina Nurse', role: 'STAFF',
        profession: 'NURSE', authUserId: 'auth-uid-1', passwordHash: 'x',
      },
    })
    authUser.current = { id: 'auth-uid-1' }

    const session = await currentSessionUser()

    expect(session).not.toBeNull()
    expect(session!.principal).toEqual({ id: profile.id, role: 'STAFF', profession: 'NURSE' })
    expect(session!.email).toBe('nurse@c.test')
    expect(session!.name).toBe('Nina Nurse')
  })

  it('returns null for an auth user with no profile', async () => {
    authUser.current = { id: 'auth-uid-orphan' }
    expect(await currentSessionUser()).toBeNull()
  })

  it('returns null for a deactivated member even with a valid session', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: {
        email: 'gone@c.test', name: 'Gone Away', role: 'STAFF',
        profession: 'DOCTOR', authUserId: 'auth-uid-2', passwordHash: 'x',
        deactivatedAt: new Date(),
      },
    })
    authUser.current = { id: 'auth-uid-2' }

    expect(await currentSessionUser()).toBeNull()
  })

  it('reads role from the profile, never from the token', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: {
        email: 'boss@c.test', name: 'Dana Boss', role: 'MANAGER',
        profession: null, authUserId: 'auth-uid-3', passwordHash: 'x',
      },
    })
    // The mocked token carries no role at all. If the implementation ever
    // starts trusting app_metadata, this test fails — which is the point.
    authUser.current = { id: 'auth-uid-3' }

    const session = await currentSessionUser()
    expect(session!.principal.role).toBe('MANAGER')
  })
})
