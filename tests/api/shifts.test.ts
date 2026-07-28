import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'
import { encodeCursor } from '@/lib/db/paginate'

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

// --- IMP-1: impossible dates/times must be rejected, not silently --------
//     overflow-normalised into a real roster entry.
describe('POST /api/shifts — impossible/invalid dates and times (IMP-1)', () => {
  const requirements = { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }

  it.each([
    ['2026-02-31', '08:00', '16:00'], // Feb has no 31st — Date.UTC would silently roll to Mar 3
    ['2026-99-99', '08:00', '16:00'], // nonsense month/day — Date.UTC rolls years away
    ['2026-08-12', '99:99', '16:00'], // no such hour/minute
    ['2026-08-12', '08:00', '88:88'],
  ])('rejects date=%s startTime=%s endTime=%s with 400, not a silently-normalised 201', async (date, startTime, endTime) => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date, startTime, endTime, requirements,
    }), noParams)
    expect(res.status).toBe(400)
    const db = await getTestDb()
    expect(await db.shift.count()).toBe(0)
  })

  it('rejects a shift dated in the past', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2020-01-01', startTime: '08:00', endTime: '16:00', requirements,
    }), noParams)
    expect(res.status).toBe(400)
    const db = await getTestDb()
    expect(await db.shift.count()).toBe(0)
  })

  it('still accepts a real, future date/time', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-12', startTime: '08:00', endTime: '16:00', requirements,
    }), noParams)
    expect(res.status).toBe(201)
  })
})

// --- IMP-2: out-of-range / loosely-parsed ids must 400, never reach ------
//     Prisma (which 500s on them) or resolve to the wrong row.
describe('GET /api/shifts/:id — malformed ids (IMP-2)', () => {
  it.each([
    '2147483648', // one past Postgres Int32 max
    '1e21', // scientific notation — Number() accepts it, Prisma does not
    '0x10', // hex
    ' 1 ', // padded — must NOT silently resolve to shift 1
    '', // empty string — Number('') is 0, which is technically an integer
    '-1',
    '1.5',
  ])('id=%j is rejected with 400, not a 500 or a wrongly-resolved row', async (rawId) => {
    await asManager()
    const res = await shiftGet(
      req('GET', `http://localhost/api/shifts/${encodeURIComponent(rawId)}`),
      { params: Promise.resolve({ id: rawId }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('still resolves a real id', async () => {
    await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-05T08:00:00Z'), endsAt: new Date('2026-09-05T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    const res = await shiftGet(
      req('GET', `http://localhost/api/shifts/${shift.id}`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(200)
  })
})

// --- IMP-3: an ordinary bad query string must 400, never 500 with a -----
//     leaked Prisma/Zod stack trace.
describe('GET /api/shifts — bad limit query strings (IMP-3)', () => {
  it.each(['abc', '0', '-5', '101', '1000', '', 'Infinity', '2.5'])(
    'limit=%s yields 400, not a 500',
    async (limit) => {
      await asManager()
      const res = await shiftsGet(req('GET', `http://localhost/api/shifts?limit=${encodeURIComponent(limit)}`), noParams)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).toBe('INVALID_INPUT')
    },
  )

  it('a well-formed limit still works', async () => {
    await asManager()
    const res = await shiftsGet(req('GET', 'http://localhost/api/shifts?limit=10'), noParams)
    expect(res.status).toBe(200)
  })
})

// --- IMP-4: a forged cursor with an oversized id must degrade gracefully -
//     to a fresh first page, like every other malformed cursor already does.
describe('GET /api/shifts — oversized cursor (IMP-4)', () => {
  it('a cursor encoding an out-of-Int32-range id degrades to 200, not a 500', async () => {
    await asManager()
    const db = await getTestDb()
    await db.shift.create({
      data: {
        startsAt: new Date('2026-09-06T08:00:00Z'), endsAt: new Date('2026-09-06T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })

    const oversizedCursor = Buffer.from('id:99999999999999999999', 'utf8').toString('base64url')
    const res = await shiftsGet(
      req('GET', `http://localhost/api/shifts?cursor=${oversizedCursor}`),
      noParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { items: unknown[] }
    expect(body.items.length).toBeGreaterThan(0)
  })

  it('a well-formed cursor still walks pages normally', async () => {
    await asManager()
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-09-07T08:00:00Z'), endsAt: new Date('2026-09-07T16:00:00Z'),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
    const res = await shiftsGet(
      req('GET', `http://localhost/api/shifts?cursor=${encodeCursor(shift.id - 1 >= 1 ? shift.id - 1 : shift.id)}`),
      noParams,
    )
    expect(res.status).toBe(200)
  })
})

// --- IMP-5: dryRun must fail SAFE — only '1'/'true' preview; only ---------
//     absent/'0'/'false' confirm; anything else is rejected outright.
describe('PATCH & DELETE /api/shifts/:id — dryRun must not fail unsafe (IMP-5)', () => {
  async function makeShift(day: string) {
    const db = await getTestDb()
    return db.shift.create({
      data: {
        startsAt: new Date(`${day}T08:00:00Z`), endsAt: new Date(`${day}T16:00:00Z`),
        requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
      },
    })
  }

  it('PATCH ?dryRun=true previews only — the shift is NOT modified', async () => {
    await asManager()
    const shift = await makeShift('2026-09-08')
    const res = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}?dryRun=true`, {
        date: '2026-09-08', startTime: '10:00', endTime: '18:00',
        requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(200)
    const db = await getTestDb()
    const untouched = await db.shift.findUniqueOrThrow({ where: { id: shift.id } })
    expect(untouched.startsAt.toISOString()).toBe('2026-09-08T08:00:00.000Z')
    expect(untouched.version).toBe(0)
  })

  it('PATCH ?dryRun=yes is rejected outright (never silently treated as confirm)', async () => {
    await asManager()
    const shift = await makeShift('2026-09-09')
    const res = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}?dryRun=yes`, {
        date: '2026-09-09', startTime: '10:00', endTime: '18:00',
        requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
        expectedVersion: 0, claimsToken: '0:',
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(400)
    const db = await getTestDb()
    const untouched = await db.shift.findUniqueOrThrow({ where: { id: shift.id } })
    expect(untouched.version).toBe(0)
  })

  it('PATCH bare ?dryRun (empty value) is rejected outright', async () => {
    await asManager()
    const shift = await makeShift('2026-09-10')
    const res = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}?dryRun`, {
        date: '2026-09-10', startTime: '10:00', endTime: '18:00',
        requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
        expectedVersion: 0, claimsToken: '0:',
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(400)
    const db = await getTestDb()
    expect((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).version).toBe(0)
  })

  it('DELETE ?dryRun=true previews only — the shift is NOT deleted', async () => {
    await asManager()
    const shift = await makeShift('2026-09-11')
    const res = await shiftDelete(
      req('DELETE', `http://localhost/api/shifts/${shift.id}?dryRun=true`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(200)
    const db = await getTestDb()
    expect(await db.shift.findUnique({ where: { id: shift.id } })).not.toBeNull()
  })

  it('DELETE ?dryRun=maybe is rejected outright (never silently destroys)', async () => {
    await asManager()
    const shift = await makeShift('2026-09-12')
    const res = await shiftDelete(
      req('DELETE', `http://localhost/api/shifts/${shift.id}?dryRun=maybe`),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(400)
    const db = await getTestDb()
    expect(await db.shift.findUnique({ where: { id: shift.id } })).not.toBeNull()
  })

  it('PATCH with dryRun omitted still requires expectedVersion/claimsToken to confirm (MIN-4)', async () => {
    await asManager()
    const shift = await makeShift('2026-09-13')
    const res = await shiftPatch(
      req('PATCH', `http://localhost/api/shifts/${shift.id}`, {
        date: '2026-09-13', startTime: '10:00', endTime: '18:00',
        requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
        // expectedVersion/claimsToken deliberately omitted
      }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(400)
  })
})

// --- MIN-5: recurrence must not silently truncate at the 366-row cap -----
describe('POST /api/shifts — recurrence bounds (MIN-5)', () => {
  it('rejects an untilDate more than a year out rather than silently clipping at 366 rows', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-03', startTime: '08:00', endTime: '16:00', // 2026-08-03 is a Monday
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
      recurrence: { weekdays: [0, 1, 2, 3, 4, 5, 6], untilDate: '9999-12-31' },
    }), noParams)
    expect(res.status).toBe(400)
    const db = await getTestDb()
    expect(await db.shift.count()).toBe(0)
  })

  it('rejects an invalid untilDate rather than reporting the misleading "covers no dates"', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-03', startTime: '08:00', endTime: '16:00',
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
      recurrence: { weekdays: [1], untilDate: '9999-99-99' },
    }), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
    expect(body.error.message).not.toMatch(/covers no dates/i)
  })

  it('still accepts a recurrence within bounds', async () => {
    await asManager()
    const res = await shiftsPost(req('POST', 'http://localhost/api/shifts', {
      date: '2026-08-03', startTime: '08:00', endTime: '16:00',
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
      recurrence: { weekdays: [1], untilDate: '2026-08-24' },
    }), noParams)
    expect(res.status).toBe(201)
    const body = await res.json() as { ids: number[] }
    expect(body.ids.length).toBeGreaterThan(1)
  })
})
