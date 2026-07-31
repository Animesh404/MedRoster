import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const route = await import('@/app/api/cron/prune/route')

const SECRET = 'test-cron-secret'
const original = process.env.CRON_SECRET

beforeEach(async () => {
  await resetTestDb()
  process.env.CRON_SECRET = SECRET
})
afterEach(() => {
  if (original === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = original
})
afterAll(stopTestDb)

const req = (auth?: string) =>
  new Request('http://localhost/api/cron/prune', {
    headers: auth === undefined ? {} : { authorization: auth },
  })

async function seedExpired(id: string) {
  const db = await getTestDb()
  await db.mutationOutcome.create({
    data: {
      mutationId: id,
      scope: 'claim:1:1:self',
      result: { claimId: 1 },
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    },
  })
}

/**
 * The app's only unauthenticated endpoint, and it deletes rows — so it is the
 * one route whose guard is worth exercising rather than inferring.
 */
describe('cron/prune', () => {
  // The defect that shipped in the first version: Vercel Cron sends an HTTP
  // GET, and the route exported only POST. The nightly job would have 405'd
  // forever while every test stayed green and `npm run db:prune` worked fine
  // locally — a mechanism with no working consumer.
  it('exports GET, which is the method Vercel Cron actually sends', () => {
    expect(typeof route.GET).toBe('function')
  })

  it('also exports POST, so a human can trigger it by hand', () => {
    expect(typeof route.POST).toBe('function')
  })

  it('refuses with no Authorization header', async () => {
    await seedExpired('should-survive')
    const db = await getTestDb()

    const res = await route.GET(req())

    expect(res.status).toBe(403)
    expect(await db.mutationOutcome.count()).toBe(1)
  })

  it('refuses a wrong secret', async () => {
    await seedExpired('should-survive')
    const db = await getTestDb()

    const res = await route.GET(req('Bearer not-the-secret'))

    expect(res.status).toBe(403)
    expect(await db.mutationOutcome.count()).toBe(1)
  })

  // Failing closed matters more here than usual: the endpoint mutates data, and
  // an unconfigured deployment running it open would be a lever anyone can pull.
  it('refuses everything when CRON_SECRET is unset, rather than running open', async () => {
    delete process.env.CRON_SECRET
    await seedExpired('should-survive')
    const db = await getTestDb()

    const res = await route.GET(req('Bearer anything'))

    expect(res.status).toBe(403)
    expect(await db.mutationOutcome.count()).toBe(1)
  })

  it('prunes expired records with the right secret', async () => {
    await seedExpired('expired-1')
    await seedExpired('expired-2')
    const db = await getTestDb()
    await db.mutationOutcome.create({
      data: { mutationId: 'fresh', scope: 'claim:2:2:self', result: { claimId: 2 } },
    })

    const res = await route.GET(req(`Bearer ${SECRET}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 2, exhausted: false, mutationOutcomes: 2, dropNotices: 0, outboxEvents: 0 })
    const left = await db.mutationOutcome.findMany({ select: { mutationId: true } })
    expect(left.map((r) => r.mutationId)).toEqual(['fresh'])
  })

  // The handler takes no parameters at all, so even somebody holding the secret
  // cannot pass `now` or `batchSize` and make it delete live records.
  it('accepts no caller-supplied tuning, so the window cannot be widened remotely', async () => {
    const db = await getTestDb()
    await db.mutationOutcome.create({
      data: { mutationId: 'fresh', scope: 'claim:2:2:self', result: { claimId: 2 } },
    })

    const res = await route.GET(
      new Request('http://localhost/api/cron/prune?now=2099-01-01&batchSize=9999', {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    )

    expect(res.status).toBe(200)
    expect(await db.mutationOutcome.count()).toBe(1)
  })
})

/**
 * Outbox pruning, wired in at a 10-day window.
 *
 * The tests that matter here are not "does it delete" — it is the watermark
 * that makes deleting safe. A run that deletes rows without advancing
 * `prunedUpTo` is the silent-data-loss case this whole mechanism exists to
 * prevent: a client polling `id > lastId` for rows that are gone receives an
 * empty page and concludes it is up to date.
 */
describe('cron/prune — EventOutbox', () => {
  async function seedEvent(ageMs: number) {
    const db = await getTestDb()
    return db.eventOutbox.create({
      data: {
        topic: 'week:2026-W31', type: 'shift.claims_dropped', payload: { shiftId: 1 },
        createdAt: new Date(Date.now() - ageMs),
      },
    })
  }

  it('deletes events past the retention window and keeps the rest', async () => {
    const db = await getTestDb()
    const { OUTBOX_RETENTION_MS } = await import('@/lib/rules/retention')
    const old = await seedEvent(OUTBOX_RETENTION_MS + 86_400_000)
    const recent = await seedEvent(60_000)

    const res = await route.GET(req(`Bearer ${SECRET}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outboxEvents: 1 })
    const left = await db.eventOutbox.findMany({ select: { id: true } })
    expect(left.map((r) => r.id)).toEqual([recent.id])
    expect(left.map((r) => r.id)).not.toContain(old.id)
  })

  // The safety property. Deleting without this is the silent loss.
  it('advances the watermark to the highest id it deleted', async () => {
    const db = await getTestDb()
    const { OUTBOX_RETENTION_MS, prunedWatermark } = await import('@/lib/rules/retention')
    await seedEvent(OUTBOX_RETENTION_MS + 86_400_000)
    const newest = await seedEvent(OUTBOX_RETENTION_MS + 3_600_000)

    await route.GET(req(`Bearer ${SECRET}`))

    expect(await prunedWatermark(db)).toBe(newest.id)
  })

  it('leaves the watermark alone when there is nothing to prune', async () => {
    const db = await getTestDb()
    const { prunedWatermark } = await import('@/lib/rules/retention')
    await seedEvent(60_000)

    await route.GET(req(`Bearer ${SECRET}`))

    expect(await prunedWatermark(db)).toBe(BigInt(0))
    expect(await db.eventOutbox.count()).toBe(1)
  })

})

/**
 * The job's other half. Without this the route could stop calling
 * `pruneDropNotices` entirely and every test above would stay green.
 */
describe('cron/prune — drop notices', () => {
  it('deletes drop notices nobody can see any more', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'n@c.test', name: 'N', role: 'STAFF', profession: 'NURSE' },
    })
    const { DROP_NOTICE_RETENTION_MS } = await import('@/lib/rules/retention')
    const old = new Date(Date.now() - DROP_NOTICE_RETENTION_MS - 60_000)
    await db.dropNotice.create({
      data: { userId: nurse.id, shiftId: 1, kind: 'dropped', reason: 'r', createdAt: old, shiftStartsAt: old },
    })
    await db.dropNotice.create({
      data: { userId: nurse.id, shiftId: 2, kind: 'dropped', reason: 'r', shiftStartsAt: new Date(Date.now() + 86_400_000) },
    })

    const res = await route.GET(req(`Bearer ${SECRET}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dropNotices: 1 })
    // The live one survives — the job prunes the invisible, not the unread.
    const left = await db.dropNotice.findMany({ select: { shiftId: true } })
    expect(left.map((r) => r.shiftId)).toEqual([2])
  })
})
