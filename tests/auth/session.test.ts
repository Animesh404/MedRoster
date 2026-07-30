import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const authUser = vi.hoisted(() => ({
  current: null as { id: string; app_metadata?: { role?: string; profession?: string } } | null,
}))

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
        profession: 'NURSE', authUserId: 'auth-uid-1',
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
        profession: 'DOCTOR', authUserId: 'auth-uid-2',
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
        profession: null, authUserId: 'auth-uid-3',
      },
    })
    // The token carries a CONFLICTING role/profession claim — STAFF/NURSE —
    // against a profile row that says MANAGER/null. If the implementation
    // ever reads app_metadata, even as a fallback, this test fails: the
    // profile's values must win outright, not merely fill gaps the token
    // leaves open.
    authUser.current = { id: 'auth-uid-3', app_metadata: { role: 'STAFF', profession: 'NURSE' } }

    const session = await currentSessionUser()
    expect(session!.principal).toEqual({ id: expect.any(Number), role: 'MANAGER', profession: null })
  })

  it('does not let a token claim resuscitate a deactivated member', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: {
        email: 'ghost@c.test', name: 'Ghost Manager', role: 'STAFF',
        profession: 'DOCTOR', authUserId: 'auth-uid-4',
        deactivatedAt: new Date(),
      },
    })
    // Even a token asserting a privileged role must not override the
    // deactivated profile — deactivation fails closed regardless of claims.
    authUser.current = { id: 'auth-uid-4', app_metadata: { role: 'MANAGER' } }

    expect(await currentSessionUser()).toBeNull()
  })
})
