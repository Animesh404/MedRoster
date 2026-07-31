import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'
import {
  DEFAULT_THEME,
  THEME_COOKIE,
  parseThemePreference,
  resolveThemeAttribute,
} from '@/lib/theme/preference'

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

let session: { id: number; email: string; name: string; role: 'STAFF' | 'MANAGER' } | null = null

vi.mock('@/lib/auth/session', () => ({
  currentSessionUser: () => Promise.resolve(
    session && {
      authUserId: 'auth-uid',
      email: session.email,
      name: session.name,
      principal: { id: session.id, role: session.role, profession: 'NURSE' },
    },
  ),
}))

const { PATCH } = await import('@/app/api/me/theme/route')

const noParams = { params: Promise.resolve({}) }
const req = (body: unknown) =>
  new Request('http://localhost/api/me/theme', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

beforeEach(async () => {
  await resetTestDb()
  session = null
})
afterAll(stopTestDb)

async function signIn(email = 'n@c.test') {
  const db = await getTestDb()
  const user = await db.user.create({
    data: { email, name: 'Nina', role: 'STAFF', profession: 'NURSE' },
  })
  session = { id: user.id, email: user.email, name: user.name, role: 'STAFF' }
  return user
}

describe('parseThemePreference', () => {
  it('accepts exactly the three real preferences', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
  })

  // Everything reaching this is untrusted: a cookie is client-editable and the
  // request body is whatever was posted.
  it('rejects anything else rather than guessing', () => {
    for (const bad of ['', 'DARK', 'chartreuse', null, undefined, 42, {}, ['dark']]) {
      expect(parseThemePreference(bad)).toBeNull()
    }
  })

  // A tampered cookie must degrade to the default, not blank the attribute —
  // an empty `data-theme` matches none of the CSS selectors.
  it('falls back to the default when rendering an unusable value', () => {
    expect(resolveThemeAttribute('chartreuse')).toBe(DEFAULT_THEME)
    expect(resolveThemeAttribute(undefined)).toBe(DEFAULT_THEME)
    expect(DEFAULT_THEME).toBe('system')
  })
})

describe('PATCH /api/me/theme', () => {
  it('saves the preference against the signed-in member', async () => {
    const db = await getTestDb()
    const user = await signIn()

    const res = await PATCH(req({ theme: 'dark' }), noParams)

    expect(res.status).toBe(200)
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(stored.themePreference).toBe('dark')
  })

  it('sets the cookie so the next server render agrees with the client', async () => {
    await signIn()
    const res = await PATCH(req({ theme: 'light' }), noParams)

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${THEME_COOKIE}=light`)
    // Readable by the toggle, which writes it directly for the instant flip.
    expect(cookie.toLowerCase()).not.toContain('httponly')
  })

  /**
   * The only authorization question this endpoint has is *whose* preference,
   * and it is answered by writing to `principal.id`. If it ever read an id from
   * the body, one member could restyle another's account.
   */
  it('ignores any user id in the body and writes only to the caller', async () => {
    const db = await getTestDb()
    const me = await signIn('me@c.test')
    const other = await db.user.create({
      data: { email: 'other@c.test', name: 'Other', role: 'STAFF', profession: 'NURSE' },
    })

    await PATCH(req({ theme: 'dark', userId: other.id, id: other.id }), noParams)

    expect((await db.user.findUniqueOrThrow({ where: { id: me.id } })).themePreference).toBe('dark')
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).themePreference).toBeNull()
  })

  it('rejects a theme it does not recognise', async () => {
    const db = await getTestDb()
    const user = await signIn()

    const res = await PATCH(req({ theme: 'chartreuse' }), noParams)

    expect(res.status).toBe(400)
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).themePreference).toBeNull()
  })

  it('rejects a body that is not JSON, rather than throwing', async () => {
    await signIn()
    const res = await PATCH(req('not json at all'), noParams)
    expect(res.status).toBe(400)
  })

  it('refuses an anonymous caller', async () => {
    session = null
    const res = await PATCH(req({ theme: 'dark' }), noParams)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
