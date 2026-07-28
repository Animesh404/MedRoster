import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

// Route handlers call `prisma` imported from '@/lib/db/client', which in
// production wires a real driver adapter off `process.env.DATABASE_URL`.
// Tests redirect that import to the same Testcontainers instance the rest
// of the suite uses, so the routes are exercised against a real Postgres
// without needing a live DATABASE_URL in the test environment.
vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

let session: { user: { id: number; email: string; name: string; role: 'STAFF' | 'MANAGER'; profession: string | null } } | null = null
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(session) }))

const { GET: shiftsGet, POST: shiftsPost } = await import('@/app/api/shifts/route')
const { GET: shiftGet, PATCH: shiftPatch, DELETE: shiftDelete } = await import('@/app/api/shifts/[id]/route')

function req(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** `/api/shifts` has no dynamic segments, but `withAuth`'s wrapper always
 *  takes a `ctx` positionally regardless of whether the handler reads it. */
const noParams = { params: Promise.resolve({}) }

async function asManager() {
  const db = await getTestDb()
  const manager = await db.user.create({
    data: { email: 'mgr@c.test', name: 'Manager', passwordHash: 'x', role: 'MANAGER', profession: null },
  })
  session = { user: { id: manager.id, email: manager.email, name: manager.name, role: 'MANAGER', profession: null } }
  return manager
}

beforeEach(() => { session = null })
beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('POST /api/shifts', () => {
  it('creates a single shift with the resolved UTC window', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-12', startTime: '08:00', endTime: '16:00',
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
    }), noParams)
    expect(res.status).toBe(201)
    const body = await res.json() as { ids: number[]; seriesId: number | null }
    expect(body.ids).toHaveLength(1)
    expect(body.seriesId).toBeNull()

    const db = await getTestDb()
    const shift = await db.shift.findUniqueOrThrow({ where: { id: body.ids[0]! } })
    expect(shift.startsAt.toISOString()).toBe('2026-08-12T07:00:00.000Z') // BST
  })

  it('rejects a shift that needs nobody', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-12', startTime: '08:00', endTime: '16:00',
      requirements: { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 },
    }), noParams)
    expect(res.status).toBe(400)
  })
})

describe('GET /api/shifts', () => {
  it('paginates the shift list', async () => {
    await asManager()
    const db = await getTestDb()
    for (let i = 0; i < 3; i++) {
      await db.shift.create({
        data: {
          startsAt: new Date(`2026-08-${12 + i}T08:00:00Z`), endsAt: new Date(`2026-08-${12 + i}T16:00:00Z`),
          requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
        },
      })
    }
    const res = await shiftsGet(req('GET', 'http://localhost/api/shifts?limit=2'), noParams)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[]; nextCursor: string | null }
    expect(body.items).toHaveLength(2)
    expect(body.nextCursor).not.toBeNull()
  })
})

describe('PATCH /api/shifts/:id — version + claimsToken threading', () => {
  it('dry-run returns a preview; confirming against it succeeds and bumps the version', async () => {
    const manager = await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-01T08:00:00Z'), endsAt: new Date('2026-09-01T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
      },
    })

    const dryRunRes = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}?dryRun=1`, {
        date: '2026-09-01', startTime: '09:00', endTime: '17:00',
        requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
        expectedVersion: 0, claimsToken: 'placeholder', // ignored on dry-run
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(dryRunRes.status).toBe(200)
    const preview = await dryRunRes.json() as { version: number; claimsToken: string; kept: number[]; dropped: unknown[] }
    expect(preview.version).toBe(0)
    expect(preview.kept).toEqual([])

    const confirmRes = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}`, {
        date: '2026-09-01', startTime: '09:00', endTime: '17:00',
        requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
        expectedVersion: preview.version, claimsToken: preview.claimsToken,
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(confirmRes.status).toBe(200)

    const updated = await db.shift.findUniqueOrThrow({ where: { id: shift.id } })
    expect(updated.version).toBe(1)
    expect(updated.startsAt.toISOString()).toBe('2026-09-01T08:00:00.000Z')
    void manager
  })

  it('rejects a confirm whose claimsToken no longer matches (a claim landed after the preview)', async () => {
    await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-02T08:00:00Z'), endsAt: new Date('2026-09-02T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
      },
    })

    const dryRunRes = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}?dryRun=1`, {
        date: '2026-09-02', startTime: '09:00', endTime: '17:00',
        requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
        expectedVersion: 0, claimsToken: 'placeholder',
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    const preview = await dryRunRes.json() as { version: number; claimsToken: string }

    // A claim lands on the shift AFTER the preview was taken but BEFORE the
    // manager confirms — the exact race `claimsToken` exists to catch.
    const nurse = await db.user.create({
      data: { email: 'race-nurse@c.test', name: 'Race Nurse', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await db.claim.create({ data: { shiftId: shift.id, userId: nurse.id } })

    const confirmRes = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}`, {
        date: '2026-09-02', startTime: '09:00', endTime: '17:00',
        requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
        expectedVersion: preview.version, claimsToken: preview.claimsToken,
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(confirmRes.status).toBe(409)
    const errBody = await confirmRes.json() as { error: { code: string } }
    expect(errBody.error.code).toBe('VERSION_CONFLICT')
  })
})

describe('GET/DELETE /api/shifts/:id', () => {
  it('reads a shift with its requirements and claims', async () => {
    await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-03T08:00:00Z'), endsAt: new Date('2026-09-03T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    const res = await shiftGet(
      req('GET', `http://localhost/api/shifts/${shift.id}`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { id: number; requirements: unknown[] }
    expect(body.id).toBe(shift.id)
    expect(body.requirements).toHaveLength(1)
  })

  it('deletes a shift after a matching dry-run preview', async () => {
    await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-04T08:00:00Z'), endsAt: new Date('2026-09-04T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })

    const dryRunRes = await shiftDelete(
      req('DELETE', `http://localhost/api/shifts/${shift.id}?dryRun=1`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    const preview = await dryRunRes.json() as { version: number; claimsToken: string }

    const confirmRes = await shiftDelete(
      req('DELETE', `http://localhost/api/shifts/${shift.id}?expectedVersion=${preview.version}&claimsToken=${encodeURIComponent(preview.claimsToken)}`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(confirmRes.status).toBe(200)
    expect(await db.shift.findUnique({ where: { id: shift.id } })).toBeNull()
  })
})
