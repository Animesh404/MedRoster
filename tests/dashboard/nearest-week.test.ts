import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveDefaultWeek } from '@/lib/dashboard/nearest-week'
import { isoWeekOf } from '@/lib/domain/time'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

async function shiftAt(iso: string) {
  const db = await getTestDb()
  return db.shift.create({
    data: {
      startsAt: new Date(iso),
      endsAt: new Date(new Date(iso).getTime() + 8 * 3_600_000),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 1 }] },
    },
  })
}

describe('resolveDefaultWeek', () => {
  const NOW = new Date('2026-07-29T09:00:00Z') // a week with no seeded shifts

  it('uses the current week when it actually has shifts', async () => {
    await shiftAt('2026-07-29T09:00:00Z')
    expect(await resolveDefaultWeek(NOW, await getTestDb())).toBe(isoWeekOf(NOW))
  })

  it('jumps forward to the nearest upcoming week when the current one is empty', async () => {
    // The real failure this guards: seeded data starts 2026-08-03, so anyone
    // opening the dashboard in July landed on a week reading 0 everywhere and a
    // 100% gauge — 100% of nothing.
    const s = await shiftAt('2026-08-04T07:00:00Z')
    expect(await resolveDefaultWeek(NOW, await getTestDb())).toBe(isoWeekOf(s.startsAt))
  })

  it('prefers an upcoming week over a past one', async () => {
    await shiftAt('2026-06-10T07:00:00Z')
    const future = await shiftAt('2026-08-04T07:00:00Z')
    expect(await resolveDefaultWeek(NOW, await getTestDb())).toBe(isoWeekOf(future.startsAt))
  })

  it('falls back to the most recent past week when nothing is upcoming', async () => {
    const past = await shiftAt('2026-06-10T07:00:00Z')
    expect(await resolveDefaultWeek(NOW, await getTestDb())).toBe(isoWeekOf(past.startsAt))
  })

  it('returns the current week when there are no shifts at all', async () => {
    expect(await resolveDefaultWeek(NOW, await getTestDb())).toBe(isoWeekOf(NOW))
  })
})
