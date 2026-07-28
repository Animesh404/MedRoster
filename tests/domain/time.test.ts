import { describe, expect, it } from 'vitest'
import {
  addDays, clinicWallTimeToUtc, durationMinutes, isoWeekOf,
  overlaps, resolveShiftWindow, weekBounds,
} from '@/lib/domain/time'

describe('clinicWallTimeToUtc', () => {
  it('applies British Summer Time in August', () => {
    // 08:00 Europe/London in August is BST (UTC+1)
    expect(clinicWallTimeToUtc('2026-08-12', '08:00').toISOString()).toBe('2026-08-12T07:00:00.000Z')
  })

  it('applies GMT in January', () => {
    expect(clinicWallTimeToUtc('2026-01-12', '08:00').toISOString()).toBe('2026-01-12T08:00:00.000Z')
  })
})

describe('overlaps', () => {
  const iv = (s: string, e: string) => ({ startsAt: new Date(s), endsAt: new Date(e) })

  it('detects a partial overlap', () => {
    expect(overlaps(iv('2026-08-12T07:00Z', '2026-08-12T15:00Z'),
                    iv('2026-08-12T14:00Z', '2026-08-12T22:00Z'))).toBe(true)
  })

  it('treats touching intervals as non-overlapping (half-open)', () => {
    expect(overlaps(iv('2026-08-12T07:00Z', '2026-08-12T15:00Z'),
                    iv('2026-08-12T15:00Z', '2026-08-12T23:00Z'))).toBe(false)
  })

  it('detects an overnight shift overlapping the next morning', () => {
    expect(overlaps(iv('2026-08-12T21:00Z', '2026-08-13T05:00Z'),
                    iv('2026-08-13T04:00Z', '2026-08-13T12:00Z'))).toBe(true)
  })
})

describe('durationMinutes', () => {
  it('measures an overnight shift as 8 hours', () => {
    expect(durationMinutes({ startsAt: new Date('2026-08-12T21:00Z'),
                             endsAt:   new Date('2026-08-13T05:00Z') })).toBe(480)
  })
})

describe('resolveShiftWindow', () => {
  it('keeps a same-day shift on its own date', () => {
    const w = resolveShiftWindow('2026-08-12', '08:00', '16:00')
    expect(w.rolledOverToNextDay).toBe(false)
    expect(w.endsAt.toISOString()).toBe('2026-08-12T15:00:00.000Z')
  })

  it('rolls an overnight shift onto the next day', () => {
    const w = resolveShiftWindow('2026-08-12', '22:00', '06:00')
    expect(w.rolledOverToNextDay).toBe(true)
    expect(w.endsAt.toISOString()).toBe('2026-08-13T05:00:00.000Z')
  })

  it('treats a 00:00 end as midnight the following day', () => {
    const w = resolveShiftWindow('2026-08-12', '16:00', '00:00')
    expect(w.rolledOverToNextDay).toBe(true)
    expect((w.endsAt.getTime() - w.startsAt.getTime()) / 3_600_000).toBe(8)
  })

  it('honours an explicit next-day flag even when the clock reads later', () => {
    const w = resolveShiftWindow('2026-08-12', '08:00', '10:00', true)
    expect(w.rolledOverToNextDay).toBe(true)
    expect((w.endsAt.getTime() - w.startsAt.getTime()) / 3_600_000).toBe(26)
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
  })
})

describe('isoWeekOf / weekBounds', () => {
  it('places 2026-08-12 in ISO week 33', () => {
    expect(isoWeekOf(new Date('2026-08-12T07:00Z'))).toBe('2026-W33')
  })

  it('round-trips a week to a Monday-start 7-day window', () => {
    const { start, end } = weekBounds('2026-W33')
    expect(isoWeekOf(start)).toBe('2026-W33')
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(7)
  })
})
