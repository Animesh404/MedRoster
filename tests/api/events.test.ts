import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { outboxEventSchema } from '@/lib/contracts/events'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

// Route handlers call `prisma` imported from '@/lib/db/client', which in
// production wires a real driver adapter off `process.env.DATABASE_URL`.
// Tests redirect that import to the same Testcontainers instance the rest
// of the suite uses, so the route is exercised against a real Postgres
// without needing a live DATABASE_URL in the test environment.
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

const { GET: eventsSinceGet } = await import('@/app/api/events/since/route')

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

async function setup() {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: new Date('2026-12-01T09:00Z'), endsAt: new Date('2026-12-01T17:00Z'),
      requirements: { create: [
        { profession: 'NURSE', requiredCount: 3 },
        { profession: 'DOCTOR', requiredCount: 0 },
        { profession: 'RECEPTIONIST', requiredCount: 0 },
      ] },
    },
  })
  return { db, shift }
}

describe('event outbox replay', () => {
  it('assigns strictly increasing ids so a client can resume from its last seen', async () => {
    const { db, shift } = await setup()
    for (let i = 0; i < 3; i++) {
      const n = await db.user.create({
        data: { email: `n${i}@c.test`, name: `N${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
      await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })
    }

    const all = await db.eventOutbox.findMany({ orderBy: { id: 'asc' } })
    expect(all).toHaveLength(3)
    const ids = all.map((e) => Number(e.id))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    const after = await db.eventOutbox.findMany({ where: { id: { gt: all[0]!.id } }, orderBy: { id: 'asc' } })
    expect(after).toHaveLength(2)
  })

  it('carries the mutationId through so the originator can drop its own echo', async () => {
    const { db, shift } = await setup()
    const n = await db.user.create({
      data: { email: 'n@c.test', name: 'N', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id, mutationId: 'abcd1234efgh' })

    const event = await db.eventOutbox.findFirstOrThrow()
    expect(event.mutationId).toBe('abcd1234efgh')
    expect(event.topic).toBe('week:2026-W49')
  })

  it('writes no event when the mutation is rejected', async () => {
    const { db, shift } = await setup()
    const doctor = await db.user.create({
      data: { email: 'd@c.test', name: 'D', passwordHash: 'x', role: 'STAFF', profession: 'DOCTOR' },
    })
    const result = await assignClaim({ db, shiftId: shift.id, userId: doctor.id, actorId: doctor.id })

    expect('code' in result && result.code).toBe('PROFESSION_NOT_REQUIRED')
    expect(await db.eventOutbox.count()).toBe(0)
  })
})

describe('GET /api/events/since', () => {
  it('replays only events after the given id, on the requested topic', async () => {
    await asManager()
    const { db, shift } = await setup()
    const n1 = await db.user.create({
      data: { email: 'n1@c.test', name: 'N1', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    const n2 = await db.user.create({
      data: { email: 'n2@c.test', name: 'N2', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: n1.id, actorId: n1.id })
    const first = await db.eventOutbox.findFirstOrThrow()
    await assignClaim({ db, shiftId: shift.id, userId: n2.id, actorId: n2.id })

    const res = await eventsSinceGet(
      new Request(`http://localhost/api/events/since?id=${first.id}&topic=week:2026-W49`),
      noParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { events: { id: string }[]; lastId: string; truncated: boolean }
    expect(body.events).toHaveLength(1)
    expect(Number(body.events[0]!.id)).toBeGreaterThan(Number(first.id))
    expect(body.truncated).toBe(false)
    // MINOR-1: enforce outboxEventSchema against a real response instead of
    // leaving it an aspirational, never-parsed contract.
    body.events.forEach((e) => outboxEventSchema.parse(e))
  })

  it('rejects a malformed id or missing topic with 400, not a 500', async () => {
    await asManager()
    const bad = await eventsSinceGet(new Request('http://localhost/api/events/since?id=abc&topic=week:2026-W49'), noParams)
    expect(bad.status).toBe(400)

    const missingTopic = await eventsSinceGet(new Request('http://localhost/api/events/since?id=0'), noParams)
    expect(missingTopic.status).toBe(400)
  })

  it('rejects an id beyond Postgres bigint range with 400, not a 500 (CRIT-2)', async () => {
    await asManager()
    // 9223372036854775807 is the exact bigint max; one past it must not
    // reach `BigInt(...)` / Prisma at all. Without the magnitude bound,
    // Prisma throws P2020 ("Value out of range") once this hits the query
    // engine, which withAuth's boundary turns into a bare 500.
    const res = await eventsSinceGet(
      new Request('http://localhost/api/events/since?id=99999999999999999999999999&topic=week:x'),
      noParams,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('defaults id to 0 so a fresh client gets full history for the topic', async () => {
    await asManager()
    const { db, shift } = await setup()
    const n = await db.user.create({
      data: { email: 'n@c.test', name: 'N', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })

    const res = await eventsSinceGet(new Request('http://localhost/api/events/since?topic=week:2026-W49'), noParams)
    const body = await res.json() as { events: unknown[] }
    expect(body.events).toHaveLength(1)
  })
})
