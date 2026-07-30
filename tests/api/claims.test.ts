import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaimSchema } from '@/lib/contracts/claims'
import { updateShiftSchema } from '@/lib/contracts/shifts'
import { requirementsSchema } from '@/lib/contracts/common'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

describe('claim contract', () => {
  it('accepts an empty body as a self-claim', () => {
    expect(createClaimSchema.parse({})).toEqual({})
  })

  it('accepts a target user for a manager assignment', () => {
    expect(createClaimSchema.parse({ userId: 7 }).userId).toBe(7)
  })

  it('rejects a non-positive user id', () => {
    expect(createClaimSchema.safeParse({ userId: 0 }).success).toBe(false)
  })
})

describe('requirements contract', () => {
  it('rejects a shift that needs nobody', () => {
    expect(requirementsSchema.safeParse({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }).success).toBe(false)
  })

  it('rejects a negative count', () => {
    expect(requirementsSchema.safeParse({ DOCTOR: -1, NURSE: 1, RECEPTIONIST: 0 }).success).toBe(false)
  })
})

describe('update contract', () => {
  // `commitShiftEdit` takes `{ version, claimsToken }` as its confirm
  // expectation, not a bare version number (assignClaim never bumps
  // Shift.version, so version alone cannot detect a claim landing between
  // preview and confirm — see lib/rules/edit.ts's EditPreview doc comment).
  //
  // MIN-4: both are optional AT THE SCHEMA LEVEL — the `dryRun` path never
  // reads either, so requiring them here would force a client's first
  // preview request to invent placeholder values. It's the route's confirm
  // branch (tested at the route level in tests/api/shifts.test.ts) that
  // actually requires both before it will call commitShiftEdit.
  const base = {
    date: '2026-08-12', startTime: '08:00', endTime: '16:00',
    requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
  }

  it('allows omitting expectedVersion/claimsToken (the dry-run shape)', () => {
    expect(updateShiftSchema.safeParse(base).success).toBe(true)
    expect(updateShiftSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(true)
  })

  it('rejects an explicitly empty claims token, but accepts a real one', () => {
    expect(updateShiftSchema.safeParse({ ...base, expectedVersion: 0, claimsToken: '' }).success).toBe(false)
    expect(updateShiftSchema.safeParse({ ...base, expectedVersion: 0, claimsToken: '0:' }).success).toBe(true)
  })
})

// --- Route-level permission enforcement -----------------------------------
//
// tests/rbac/permissions.test.ts already proves `can(staff, 'claim:create:any')`
// is false in isolation. That is necessary but not sufficient: it does not
// prove the route actually calls `scopedPermission` before creating a claim.
// These tests exercise the real POST handler end to end (real DB, mocked
// session) to confirm a staff member cannot assign anyone but themselves.

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

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { POST: claimPost } = await import('@/app/api/shifts/[id]/claims/route')
const { DELETE: claimDelete } = await import('@/app/api/shifts/[id]/claims/[userId]/route')

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function rawRequest(url: string, rawBody: string) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody,
  })
}

async function makeShift() {
  const db = await getTestDb()
  return db.shift.create({
    data: {
      startsAt: new Date('2026-12-01T09:00:00Z'),
      endsAt: new Date('2026-12-01T17:00:00Z'),
      requirements: { create: [
        { profession: 'NURSE', requiredCount: 2 },
        { profession: 'DOCTOR', requiredCount: 0 },
        { profession: 'RECEPTIONIST', requiredCount: 0 },
      ] },
    },
  })
}

async function makeUser(role: 'STAFF' | 'MANAGER', profession: 'NURSE' | null, i: number) {
  const db = await getTestDb()
  return db.user.create({
    data: {
      email: `route-${i}@c.test`, name: `Route User ${i}`, passwordHash: 'x',
      role, profession,
    },
  })
}

beforeEach(() => { session = null })
beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('POST /api/shifts/:id/claims — permission enforcement', () => {
  it('lets staff claim the shift for themselves', async () => {
    const shift = await makeShift()
    const nurse = await makeUser('STAFF', 'NURSE', 1)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimPost(
      jsonRequest('http://localhost/api/shifts/x/claims', {}),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(201)

    const db = await getTestDb()
    const claims = await db.claim.findMany({ where: { shiftId: shift.id } })
    expect(claims.map((c) => c.userId)).toEqual([nurse.id])
  })

  it('forbids a staff member from claiming the shift for someone else', async () => {
    const shift = await makeShift()
    const nurse = await makeUser('STAFF', 'NURSE', 2)
    const other = await makeUser('STAFF', 'NURSE', 3)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimPost(
      jsonRequest('http://localhost/api/shifts/x/claims', { userId: other.id }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(403)

    const db = await getTestDb()
    const claims = await db.claim.findMany({ where: { shiftId: shift.id } })
    expect(claims).toHaveLength(0)
  })

  it('lets a manager assign the shift to another user', async () => {
    const shift = await makeShift()
    const manager = await makeUser('MANAGER', null, 4)
    const nurse = await makeUser('STAFF', 'NURSE', 5)
    session = { user: { id: manager.id, email: manager.email, name: manager.name, role: 'MANAGER', profession: null } }

    const res = await claimPost(
      jsonRequest('http://localhost/api/shifts/x/claims', { userId: nurse.id }),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(201)

    const db = await getTestDb()
    const claims = await db.claim.findMany({ where: { shiftId: shift.id } })
    expect(claims.map((c) => c.userId)).toEqual([nurse.id])
    expect(claims[0]!.assignedById).toBe(manager.id)
  })
})

// --- MIN-1: malformed JSON must 400, not silently become {} -> a real ----
//     self-claim. A genuinely empty body is legitimately {} (self-claim).
describe('POST /api/shifts/:id/claims — malformed body (MIN-1)', () => {
  it('a truncated/malformed JSON body is rejected with 400 and creates no claim', async () => {
    const shift = await makeShift()
    const nurse = await makeUser('STAFF', 'NURSE', 10)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimPost(
      rawRequest('http://localhost/api/shifts/x/claims', '{"userId":'), // truncated
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')

    const db = await getTestDb()
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(0)
  })

  it('a genuinely empty body (content-length 0) is still treated as {} — a self-claim', async () => {
    const shift = await makeShift()
    const nurse = await makeUser('STAFF', 'NURSE', 11)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimPost(
      rawRequest('http://localhost/api/shifts/x/claims', ''),
      { params: Promise.resolve({ id: String(shift.id) }) },
    )
    expect(res.status).toBe(201)

    const db = await getTestDb()
    const claims = await db.claim.findMany({ where: { shiftId: shift.id } })
    expect(claims.map((c) => c.userId)).toEqual([nurse.id])
  })
})

// --- IMP-2: out-of-range / loosely-parsed ids must 400, not 500 (claim ----
//     routes use the same shared parseDbId as the shift routes).
describe('claim routes — malformed ids (IMP-2)', () => {
  it('POST /api/shifts/:id/claims with an out-of-Int32-range shift id is rejected with 400, not a Prisma 500', async () => {
    const nurse = await makeUser('STAFF', 'NURSE', 20)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimPost(
      jsonRequest('http://localhost/api/shifts/x/claims', {}),
      { params: Promise.resolve({ id: '2147483648' }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('DELETE /api/shifts/:id/claims/:userId with a loosely-parsed userId (" 1 ") is rejected with 400', async () => {
    const shift = await makeShift()
    const nurse = await makeUser('STAFF', 'NURSE', 21)
    session = { user: { id: nurse.id, email: nurse.email, name: nurse.name, role: 'STAFF', profession: 'NURSE' } }

    const res = await claimDelete(
      new Request(`http://localhost/api/shifts/${shift.id}/claims/x`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: String(shift.id), userId: ' 1 ' }) },
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })
})
