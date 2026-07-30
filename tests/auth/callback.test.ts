import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const exchanged = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  error: null as null | { message: string },
}))
const signOut = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: {
        exchangeCodeForSession: () =>
          Promise.resolve({ data: { user: exchanged.user }, error: exchanged.error }),
        signOut,
      },
    }),
}))

const deleted = vi.hoisted(() => [] as string[])
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: { admin: { deleteUser: (id: string) => { deleted.push(id); return Promise.resolve({ error: null }) } } },
  }),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { GET } = await import('@/app/auth/callback/route')

beforeEach(async () => {
  await resetTestDb()
  signOut.mockReset()
  deleted.length = 0
  exchanged.error = null
})
afterAll(stopTestDb)

const req = () => new Request('http://localhost/auth/callback?code=abc123')

/**
 * Reads the `error` param back out, DECODED.
 *
 * `URLSearchParams.set` encodes spaces as `+`, so the raw Location header reads
 * `?error=This+account+is+no+longer+active.` and a regex like
 * `/no longer active/i` tested against the raw string fails — against a
 * perfectly correct implementation. Verified directly. Asserting on the decoded
 * value is the difference between a test that pins behaviour and one that
 * pressures the next engineer into weakening it.
 */
function errorOf(res: Response): string | null {
  return new URL(res.headers.get('location')!).searchParams.get('error')
}

describe('GET /auth/callback', () => {
  it('lets an active, invited member through to the dashboard', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'ivy@c.test', name: 'Ivy', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-ivy' },
    })
    exchanged.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(req())

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/dashboard')
    expect(signOut).not.toHaveBeenCalled()
  })

  // The hole this route exists to close: a Google identity for an address
  // nobody invited must not become an account.
  it('refuses an identity with no roster profile, and deletes the orphan account', async () => {
    exchanged.user = { id: 'uid-stranger', email: 'stranger@evil.test' }

    const res = await GET(req())

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
    expect(deleted).toEqual(['uid-stranger'])
  })

  // An imported staff.csv row: real profile, real address, never invited.
  //
  // The auth user OAuth just minted must be deleted too. Leaving it alive
  // bricks that address permanently: the next `inviteMember` sees
  // `existing.authUserId === null`, proceeds to `inviteUserByEmail`, gets
  // `email_exists`, and fails — for good, until somebody deletes the stray
  // account by hand in the dashboard.
  it('refuses a profile that was never invited, and cleans up the minted account', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'imported@c.test', name: 'Imported', role: 'STAFF', profession: 'NURSE' },
    })
    exchanged.user = { id: 'uid-new', email: 'imported@c.test' }

    const res = await GET(req())

    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
    expect(deleted).toEqual(['uid-new'])
  })

  it('refuses a deactivated member', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: {
        email: 'gone@c.test', name: 'Gone', role: 'STAFF', profession: 'NURSE',
        authUserId: 'uid-gone', deactivatedAt: new Date(),
      },
    })
    exchanged.user = { id: 'uid-gone', email: 'gone@c.test' }

    const res = await GET(req())

    expect(errorOf(res)).toMatch(/no longer active/i)
    expect(signOut).toHaveBeenCalled()
    // A deactivated member's account is banned, not deleted — deleting it would
    // discard the audit trail and let them be silently re-invited as new.
    expect(deleted).toEqual([])
  })

  it('redirects to login when the code exchange itself fails', async () => {
    exchanged.user = null
    exchanged.error = { message: 'invalid request: both auth code and code verifier should be non-empty' }

    const res = await GET(req())

    expect(res.headers.get('location')).toMatch(/\/login\?/)
    expect(deleted).toEqual([])
  })

  it('redirects to login when there is no code at all', async () => {
    const res = await GET(new Request('http://localhost/auth/callback'))
    expect(res.headers.get('location')).toMatch(/\/login\?/)
  })
})
