import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  OUTBOX_RETENTION_MS, prunedWatermark, pruneEventOutbox,
} from '@/lib/rules/retention'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')
const HOUR = 60 * 60 * 1000

/** Writes an outbox row `ageMs` old and returns its id. */
async function seedEvent(ageMs: number, topic = 'week:2026-W31') {
  const db = await getTestDb()
  const row = await db.eventOutbox.create({
    data: {
      topic, type: 'shift.claimed', payload: { shiftId: 1 },
      createdAt: new Date(NOW.getTime() - ageMs),
    },
  })
  return row.id
}

describe('pruneEventOutbox', () => {
  it('deletes events older than the retention window', async () => {
    const db = await getTestDb()
    await seedEvent(OUTBOX_RETENTION_MS + HOUR)

    const { deleted } = await pruneEventOutbox(db, { now: NOW })

    expect(deleted).toBe(1)
    expect(await db.eventOutbox.count()).toBe(0)
  })

  it('keeps events inside the window', async () => {
    const db = await getTestDb()
    await seedEvent(HOUR)

    const { deleted } = await pruneEventOutbox(db, { now: NOW })

    expect(deleted).toBe(0)
    expect(await db.eventOutbox.count()).toBe(1)
  })

  // THE property that makes pruning safe at all. If rows vanish without the
  // watermark advancing, a client polling `id > lastId` gets an empty page and
  // concludes it is caught up — silently missing everything that was deleted.
  it('advances the watermark to the highest id it deleted', async () => {
    const db = await getTestDb()
    const oldest = await seedEvent(OUTBOX_RETENTION_MS + 3 * HOUR)
    const newest = await seedEvent(OUTBOX_RETENTION_MS + HOUR)
    await seedEvent(HOUR) // survives

    await pruneEventOutbox(db, { now: NOW })

    expect(newest).toBeGreaterThan(oldest)
    expect(await prunedWatermark(db)).toBe(newest)
  })

  it('leaves the watermark alone when it deletes nothing', async () => {
    const db = await getTestDb()
    await seedEvent(HOUR)

    await pruneEventOutbox(db, { now: NOW })

    expect(await prunedWatermark(db)).toBe(BigInt(0))
  })

  // A later run that deletes lower ids (possible only via a clock change or a
  // manual insert) must not walk the watermark backwards — that would silently
  // re-expose a gap to clients that had already been told to resync.
  it('never lowers the watermark, even when a later run deletes a lower id', async () => {
    const db = await getTestDb()
    const high = await seedEvent(OUTBOX_RETENTION_MS + HOUR)
    await pruneEventOutbox(db, { now: NOW })
    expect(await prunedWatermark(db)).toBe(high)

    // An expired row with an id BELOW the current watermark. Contrived — it
    // takes a clock change or a manual insert — but it is the only input that
    // actually exercises the never-go-backwards guard. An earlier version of
    // this test just ran the pruner twice with nothing to delete, which never
    // enters the transaction at all: an unconditional overwrite passed it.
    await db.$executeRawUnsafe(`
      INSERT INTO "EventOutbox" ("id", topic, type, payload, "createdAt")
      VALUES (${Number(high) - 1}, 'week:2026-W31', 'shift.claimed', '{}'::jsonb,
              TIMESTAMPTZ '${new Date(NOW.getTime() - OUTBOX_RETENTION_MS - HOUR).toISOString()}')
    `)

    const { deleted } = await pruneEventOutbox(db, { now: NOW })

    expect(deleted).toBe(1)
    expect(await prunedWatermark(db)).toBe(high)
  })

  // The atomicity the whole design rests on. If the watermark write fails, the
  // delete must roll back with it — rows gone with the watermark not covering
  // them is precisely the silent-loss case.
  it('rolls the delete back if the watermark cannot be advanced', async () => {
    const db = await getTestDb()
    await seedEvent(OUTBOX_RETENTION_MS + HOUR)

    // Make the watermark write fail: a CHECK that rejects any row.
    await db.$executeRawUnsafe(
      `ALTER TABLE "OutboxWatermark" ADD CONSTRAINT tmp_block CHECK ("prunedUpTo" < 0) NOT VALID`)
    try {
      await expect(pruneEventOutbox(db, { now: NOW })).rejects.toThrow()
      // The event survives, because the transaction took both or neither.
      expect(await db.eventOutbox.count()).toBe(1)
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "OutboxWatermark" DROP CONSTRAINT tmp_block`)
    }
  })

  it('clears a backlog larger than one batch, watermark tracking the last id', async () => {
    const db = await getTestDb()
    const ids: bigint[] = []
    for (let i = 0; i < 25; i++) ids.push(await seedEvent(OUTBOX_RETENTION_MS + HOUR))

    const { deleted } = await pruneEventOutbox(db, { now: NOW, batchSize: 10 })

    expect(deleted).toBe(25)
    expect(await db.eventOutbox.count()).toBe(0)
    expect(await prunedWatermark(db)).toBe(ids[ids.length - 1]!)
  })

  it('prunes across topics, since the cursor is global', async () => {
    const db = await getTestDb()
    await seedEvent(OUTBOX_RETENTION_MS + HOUR, 'week:2026-W31')
    await seedEvent(OUTBOX_RETENTION_MS + HOUR, 'week:2026-W40')

    const { deleted } = await pruneEventOutbox(db, { now: NOW })

    expect(deleted).toBe(2)
  })

  it('is a no-op on an empty table', async () => {
    const db = await getTestDb()
    expect(await pruneEventOutbox(db, { now: NOW })).toEqual({ deleted: 0, exhausted: false })
  })

  // The window must comfortably outlast the client's own catch-up cadence, or
  // an ordinary backgrounded tab would resync on every return rather than
  // replaying the handful of events it actually missed.
  it('keeps events far longer than a client goes between catch-ups', () => {
    expect(OUTBOX_RETENTION_MS).toBeGreaterThanOrEqual(24 * HOUR)
  })
})
