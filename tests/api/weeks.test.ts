import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'
import type { CompressedWeek } from '@/lib/contracts/week'

// Same rationale as tests/api/shifts.test.ts: route handlers import `prisma`
// from '@/lib/db/client', which is redirected here to the shared
// Testcontainers instance instead of a real DATABASE_URL.
vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

let session: { user: { id: number; email: string; name: string; role: 'STAFF' | 'MANAGER'; profession: string | null } } | null = null

// The route handlers resolve their principal via `@/lib/auth/session`'s
// `currentSessionUser`, not `@/auth` directly, so that's what needs mocking
// here. Reshaped into `SessionUser`'s `{ principal }` shape rather than the
// old Auth.js `{ user }` shape the tests still build for convenience.
vi.mock('@/lib/auth/session', () => ({
  currentSessionUser: () => Promise.resolve(
    session && {
      authUserId: 'test-auth-user',
      email: session.user.email,
      name: session.user.name,
      principal: { id: session.user.id, role: session.user.role, profession: session.user.profession },
    },
  ),
}))

const { GET: weekGet } = await import('@/app/api/weeks/[isoWeek]/route')

function req(url: string, headers?: Record<string, string>) {
  return new Request(url, { method: 'GET', ...(headers ? { headers } : {}) })
}

async function asManager() {
  const db = await getTestDb()
  const manager = await db.user.create({
    data: { email: 'mgr@c.test', name: 'Manager', role: 'MANAGER', profession: null },
  })
  session = { user: { id: manager.id, email: manager.email, name: manager.name, role: 'MANAGER', profession: null } }
  return manager
}

beforeEach(() => { session = null })
beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('GET /api/weeks/:isoWeek', () => {
  it('rejects a malformed week string with 400 INVALID_INPUT', async () => {
    await asManager()
    const res = await weekGet(
      req('http://localhost/api/weeks/not-a-week'),
      { params: Promise.resolve({ isoWeek: 'not-a-week' }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('rejects a shape-correct week that does not exist for its year (2025 has only 52 ISO weeks)', async () => {
    await asManager()
    const res = await weekGet(
      req('http://localhost/api/weeks/2025-W53'),
      { params: Promise.resolve({ isoWeek: '2025-W53' }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('returns the compressed week payload with an ETag, and 304s on a matching If-None-Match', async () => {
    await asManager()
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'n@c.test', name: 'N', role: 'STAFF', profession: 'NURSE' },
    })
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-08-12T07:00:00Z'), endsAt: new Date('2026-08-12T15:00:00Z'),
        requirements: { create: [
          { profession: 'DOCTOR', requiredCount: 1 },
          { profession: 'NURSE', requiredCount: 1 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ] },
      },
    })
    await db.claim.create({ data: { shiftId: shift.id, userId: nurse.id } })

    const res = await weekGet(
      req('http://localhost/api/weeks/2026-W33'),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    expect(res.status).toBe(200)
    const etag = res.headers.get('ETag')
    expect(etag).toBeTruthy()

    const body = await res.json() as CompressedWeek
    expect(body.w).toBe('2026-W33')
    expect(body.s).toHaveLength(1)
    expect(body.h).toHaveLength(1)

    const cached = await weekGet(
      req('http://localhost/api/weeks/2026-W33', { 'if-none-match': etag! }),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    expect(cached.status).toBe(304)
  })

  it('only returns shifts within the requested week', async () => {
    await asManager()
    const db = await getTestDb()
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-05T07:00:00Z'), endsAt: new Date('2026-08-05T15:00:00Z'), // prior week
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-12T07:00:00Z'), endsAt: new Date('2026-08-12T15:00:00Z'), // in W33
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    const res = await weekGet(
      req('http://localhost/api/weeks/2026-W33'),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    const body = await res.json() as CompressedWeek
    expect(body.h).toHaveLength(1)
  })

  // Carried over from the Task 13 review: a reviewer verified this against
  // the route in a temporary scratch file that was deleted before it became
  // a permanent regression guard. `weekBounds('2026-W33')` spans
  // 2026-08-09T23:00:00.000Z (Monday 00:00 BST) through
  // 2026-08-16T23:00:00.000Z (the following Monday 00:00 BST) as a
  // half-open interval — [start, end).
  it('treats the week as a half-open interval: the first instant is in, the next week\'s first instant is out', async () => {
    await asManager()
    const db = await getTestDb()

    // Exactly the week's first instant — included.
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-09T23:00:00.000Z'), endsAt: new Date('2026-08-10T07:00:00.000Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    // Exactly the FOLLOWING week's first instant — excluded from W33.
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-16T23:00:00.000Z'), endsAt: new Date('2026-08-17T07:00:00.000Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    // One minute before the week starts — excluded.
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-09T22:59:00.000Z'), endsAt: new Date('2026-08-10T06:59:00.000Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    // 30 minutes before the week's end — included.
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-16T22:30:00.000Z'), endsAt: new Date('2026-08-17T02:00:00.000Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })

    const res = await weekGet(
      req('http://localhost/api/weeks/2026-W33'),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as CompressedWeek
    // h tuple layout: [id, version, startsAt, endsAt, requirements, claimants]
    const starts = body.h.map(([, , startsAt]) => startsAt).sort()
    expect(starts).toEqual(['2026-08-09T23:00:00.000Z', '2026-08-16T22:30:00.000Z'])
    expect(body.h).toHaveLength(2)
  })

  // Carried over from the Task 13 review, made permanent.
  it('changes the ETag when the underlying week data changes, so a stale ETag never serves a stale roster', async () => {
    await asManager()
    const db = await getTestDb()
    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-12T07:00:00Z'), endsAt: new Date('2026-08-12T15:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })

    const first = await weekGet(
      req('http://localhost/api/weeks/2026-W33'),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    const firstEtag = first.headers.get('ETag')
    expect(firstEtag).toBeTruthy()

    await db.shift.create({
      data: {
        startsAt: new Date('2026-08-13T07:00:00Z'), endsAt: new Date('2026-08-13T15:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })

    const second = await weekGet(
      req('http://localhost/api/weeks/2026-W33'),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    const secondEtag = second.headers.get('ETag')
    expect(secondEtag).toBeTruthy()
    expect(secondEtag).not.toBe(firstEtag)

    // Re-sending the now-stale ETag must yield a fresh 200, not a false 304
    // that would serve the client a roster missing the second shift.
    const staleRefetch = await weekGet(
      req('http://localhost/api/weeks/2026-W33', { 'if-none-match': firstEtag! }),
      { params: Promise.resolve({ isoWeek: '2026-W33' }) },
    )
    expect(staleRefetch.status).toBe(200)
  })
})
