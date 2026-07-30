import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const verified = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  error: null as null | { message: string },
  calls: [] as { type: string; token_hash: string }[],
}))
const signOut = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: {
        verifyOtp: (args: { type: string; token_hash: string }) => {
          verified.calls.push(args)
          return Promise.resolve({ data: { user: verified.user }, error: verified.error })
        },
        signOut,
      },
    }),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { GET } = await import('@/app/auth/confirm/route')

beforeEach(async () => {
  await resetTestDb()
  verified.error = null
  verified.calls.length = 0
  signOut.mockReset()
})
afterAll(stopTestDb)

const url = (params: Record<string, string>) =>
  new Request(`http://localhost/auth/confirm?${new URLSearchParams(params)}`)

async function seedMember(over: Partial<{ authUserId: string | null; deactivatedAt: Date | null }> = {}) {
  const db = await getTestDb()
  return db.user.create({
    data: {
      email: 'ivy@c.test', name: 'Ivy', role: 'STAFF', profession: 'NURSE',
      authUserId: 'uid-ivy', deactivatedAt: null, ...over,
    },
  })
}

/** Decodes the `error` query param, which URLSearchParams encodes spaces as `+`. */
function errorOf(res: Response): string | null {
  return new URL(res.headers.get('location')!).searchParams.get('error')
}

describe('GET /auth/confirm', () => {
  it('exchanges the token hash and forwards to the requested next path', async () => {
    await seedMember()
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'hash-1', type: 'invite', next: '/auth/accept-invite' }))

    expect(verified.calls).toEqual([{ type: 'invite', token_hash: 'hash-1' }])
    expect(new URL(res.headers.get('location')!).pathname).toBe('/auth/accept-invite')
  })

  // The same roster gate as every other entry point: a link is not authority.
  it('refuses a member who was deactivated after the link was sent', async () => {
    await seedMember({ deactivatedAt: new Date() })
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'recovery', next: '/auth/reset-password' }))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/no longer active/i)
    expect(signOut).toHaveBeenCalled()
  })

  it('refuses a profile that was never invited', async () => {
    await seedMember({ authUserId: null })
    verified.user = { id: 'uid-new', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'magiclink', next: '/dashboard' }))

    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
  })

  it('reports an expired or reused link instead of failing silently', async () => {
    verified.user = null
    verified.error = { message: 'Token has expired or is invalid' }

    const res = await GET(url({ token_hash: 'stale', type: 'invite', next: '/auth/accept-invite' }))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/expired/i)
  })

  it('rejects a missing token hash', async () => {
    const res = await GET(url({ type: 'invite' }))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(verified.calls).toHaveLength(0)
  })

  it('rejects an unknown otp type rather than passing it through', async () => {
    const res = await GET(url({ token_hash: 'h', type: 'not-a-type', next: '/dashboard' }))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(verified.calls).toHaveLength(0)
  })

  // email_change is a real EmailOtpType GoTrue understands, but verifyOtp
  // applies it to auth.users before this gate runs and nothing here mirrors
  // that onto Prisma's User.email — accepting it would desync the two. Must
  // stay rejected until that sync exists.
  it('rejects an email_change otp type', async () => {
    const res = await GET(url({ token_hash: 'h', type: 'email_change', next: '/dashboard' }))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(verified.calls).toHaveLength(0)
  })

  // `next` comes from an email we generated, but the route is publicly
  // reachable and the parameter is attacker-controllable in a crafted link.
  // Same open-redirect class that bit the login action in Plan 1.
  it('ignores an off-origin next parameter', async () => {
    await seedMember()
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'invite', next: 'https://evil.example/' }))

    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('http://localhost')
    expect(location.pathname).toBe('/dashboard')
  })
})
