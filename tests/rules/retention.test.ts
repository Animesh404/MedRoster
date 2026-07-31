import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pruneMutationOutcomes, MUTATION_RETENTION_MS } from '@/lib/rules/retention'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')

/** Writes an outcome row `ageMs` old, bypassing the service so age is exact. */
async function seedOutcome(id: string, ageMs: number) {
  const db = await getTestDb()
  return db.mutationOutcome.create({
    data: {
      mutationId: id,
      scope: `claim:1:1:self`,
      result: { claimId: 1 },
      createdAt: new Date(NOW.getTime() - ageMs),
    },
  })
}

const HOUR = 60 * 60 * 1000

describe('pruneMutationOutcomes', () => {
  it('deletes records older than the retention window', async () => {
    const db = await getTestDb()
    await seedOutcome('ancient', MUTATION_RETENTION_MS + HOUR)

    const { deleted } = await pruneMutationOutcomes(db, { now: NOW })

    expect(deleted).toBe(1)
    expect(await db.mutationOutcome.count()).toBe(0)
  })

  // The whole point of a retention window. Deleting a record a retry could
  // still present re-opens the bug idempotency exists to fix: the replay is
  // gone, the rules re-run, and the caller gets ALREADY_CLAIMED for an action
  // that succeeded.
  it('keeps records inside the window, however close to the edge', async () => {
    const db = await getTestDb()
    await seedOutcome('fresh', 1000)
    await seedOutcome('just-inside', MUTATION_RETENTION_MS - 1000)

    const { deleted } = await pruneMutationOutcomes(db, { now: NOW })

    expect(deleted).toBe(0)
    expect(await db.mutationOutcome.count()).toBe(2)
  })

  it('deletes only the expired ones from a mixed set', async () => {
    const db = await getTestDb()
    await seedOutcome('old-1', MUTATION_RETENTION_MS + HOUR)
    await seedOutcome('old-2', MUTATION_RETENTION_MS + 5 * HOUR)
    await seedOutcome('recent', HOUR)

    const { deleted } = await pruneMutationOutcomes(db, { now: NOW })

    expect(deleted).toBe(2)
    const survivors = await db.mutationOutcome.findMany()
    expect(survivors.map((r) => r.mutationId)).toEqual(['recent'])
  })

  it('is a no-op on an empty table', async () => {
    const db = await getTestDb()
    expect(await pruneMutationOutcomes(db, { now: NOW })).toEqual({ deleted: 0, exhausted: false })
  })

  // A backlog must not become one enormous DELETE holding a transaction open.
  // Batching keeps each statement short; the loop is what makes the total
  // complete anyway.
  it('clears a backlog larger than one batch', async () => {
    const db = await getTestDb()
    await db.mutationOutcome.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        mutationId: `bulk-${i}`,
        scope: 'claim:1:1:self',
        result: { claimId: i },
        createdAt: new Date(NOW.getTime() - MUTATION_RETENTION_MS - HOUR),
      })),
    })

    const { deleted } = await pruneMutationOutcomes(db, { now: NOW, batchSize: 100 })

    expect(deleted).toBe(250)
    expect(await db.mutationOutcome.count()).toBe(0)
  })

  it('stops at the batch ceiling rather than running unbounded', async () => {
    const db = await getTestDb()
    await db.mutationOutcome.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        mutationId: `capped-${i}`,
        scope: 'claim:1:1:self',
        result: { claimId: i },
        createdAt: new Date(NOW.getTime() - MUTATION_RETENTION_MS - HOUR),
      })),
    })

    const { deleted, exhausted } = await pruneMutationOutcomes(db, { now: NOW, batchSize: 10, maxBatches: 2 })
    expect(exhausted, 'stopping at the ceiling with work left must be reported').toBe(true)

    // Two batches of ten, then it yields rather than grinding through the rest.
    expect(deleted).toBe(20)
    expect(await db.mutationOutcome.count()).toBe(30)
  })

  // Pruning must never interfere with claiming. A claim in flight writes a NEW
  // row, which no expiry predicate can match, so the two never contend for the
  // same rows.
  it('leaves a freshly written outcome alone while clearing old ones', async () => {
    const db = await getTestDb()
    await seedOutcome('stale', MUTATION_RETENTION_MS + HOUR)
    // `createdAt` set explicitly to the prune's own "now". Letting it default
    // to the database clock would make this test depend on the wall clock
    // agreeing with the pinned NOW, which it does not.
    await db.mutationOutcome.create({
      data: {
        mutationId: 'in-flight', scope: 'claim:2:2:self',
        result: { claimId: 2 }, createdAt: NOW,
      },
    })

    const { deleted } = await pruneMutationOutcomes(db, { now: NOW })

    expect(deleted).toBe(1)
    expect(await db.mutationOutcome.findUnique({ where: { mutationId: 'in-flight' } })).not.toBeNull()
  })

  // The window has to outlast any retry a client could plausibly send. The
  // client retries once, immediately, on a transport failure; the realtime
  // echo-suppression TTL is 60s. Hours of headroom, not minutes.
  it('uses a retention window generously longer than any client retry', () => {
    expect(MUTATION_RETENTION_MS).toBeGreaterThanOrEqual(6 * HOUR)
  })
})
