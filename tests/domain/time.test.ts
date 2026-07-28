import { describe, expect, it } from 'vitest'
import {
  addDays, clinicWallTimeToUtc, durationMinutes, isoWeekOf, isoWeeksInYear,
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

  // --- clinic-local bucketing at the boundaries that motivate the fix ---
  //
  // Expected values below are hand-derived from real ISO-8601 week rules and
  // the actual 2026 UK DST transitions (BST starts 2026-03-29, ends 2026-10-25),
  // not read off whatever the implementation happens to return.

  it('buckets a near-midnight BST instant by clinic-local date, not UTC date', () => {
    // 2026-08-09T23:00Z is 2026-08-10 00:00 BST (Monday) in clinic-local time,
    // but 2026-08-09 (Sunday) in UTC. Monday 2026-08-10 falls in ISO week 33
    // (the same week as 2026-08-12, already asserted above); the UTC calendar
    // date would wrongly place it in week 32.
    expect(isoWeekOf(new Date('2026-08-09T23:00:00.000Z'))).toBe('2026-W33')
  })

  it('buckets correctly either side of the BST→GMT transition (2026-10-25)', () => {
    // Clocks go back at 02:00 BST -> 01:00 GMT, i.e. 01:00 UTC. The whole day
    // (2026-10-25, a Sunday) is the last day of ISO week 43 regardless of
    // which side of the transition instant we're on.
    expect(isoWeekOf(new Date('2026-10-25T00:59:00.000Z'))).toBe('2026-W43') // still BST
    expect(isoWeekOf(new Date('2026-10-25T01:01:00.000Z'))).toBe('2026-W43') // now GMT
    // The following Monday (GMT, no more ambiguity) starts ISO week 44.
    expect(isoWeekOf(new Date('2026-10-26T00:30:00.000Z'))).toBe('2026-W44')
  })

  it('buckets correctly either side of the GMT→BST transition (2026-03-29)', () => {
    // Clocks jump forward at 01:00 GMT -> 02:00 BST, i.e. 01:00 UTC. The whole
    // day (2026-03-29, a Sunday) is the last day of ISO week 13.
    expect(isoWeekOf(new Date('2026-03-29T00:59:00.000Z'))).toBe('2026-W13') // still GMT
    expect(isoWeekOf(new Date('2026-03-29T01:00:00.000Z'))).toBe('2026-W13') // now BST
    // 2026-03-29T23:30Z is 2026-03-30 00:30 BST (Monday) in clinic-local time,
    // but still 2026-03-29 (Sunday) in UTC — the same kind of divergence as
    // the August case above, this time landing on the BST side of the
    // spring-forward transition week. Monday 2026-03-30 starts ISO week 14.
    expect(isoWeekOf(new Date('2026-03-29T23:30:00.000Z'))).toBe('2026-W14')
  })

  it('handles the year boundary', () => {
    // 2026-01-01 is a Thursday, so it is week 1 of 2026 (a Thursday-anchored
    // ISO year always starts its own week 1 on 1 January).
    expect(isoWeekOf(clinicWallTimeToUtc('2026-01-01', '12:00'))).toBe('2026-W01')
    // 2026-12-31 is a Thursday too, and 2026 has 53 ISO weeks (see
    // isoWeeksInYear below), so the last day of the year is week 53.
    expect(isoWeekOf(clinicWallTimeToUtc('2026-12-31', '12:00'))).toBe('2026-W53')
  })

  it('round-trips every ISO week from 2024 through 2028', () => {
    for (let year = 2024; year <= 2028; year += 1) {
      const weeks = isoWeeksInYear(year)
      for (let week = 1; week <= weeks; week += 1) {
        const label = `${year}-W${String(week).padStart(2, '0')}`
        const { start } = weekBounds(label)
        expect(isoWeekOf(start)).toBe(label)
      }
    }
  })
})

describe('isoWeeksInYear', () => {
  it('reports 53 weeks for 2026 (1 Jan 2026 is a Thursday)', () => {
    expect(isoWeeksInYear(2026)).toBe(53)
  })

  it('reports 52 weeks for 2025 (1 Jan 2025 is a Wednesday, not a leap year)', () => {
    expect(isoWeeksInYear(2025)).toBe(52)
  })
})

describe('weekBounds validation', () => {
  it('accepts W53 in a genuine 53-week year (2026)', () => {
    expect(() => weekBounds('2026-W53')).not.toThrow()
  })

  it('rejects W53 in a 52-week year (2025)', () => {
    expect(() => weekBounds('2025-W53')).toThrow(/2025 has ISO weeks 1\.\.52/)
  })

  it('rejects week 0', () => {
    expect(() => weekBounds('2026-W00')).toThrow(/ISO weeks 1\.\.53/)
  })

  it('rejects week 54', () => {
    expect(() => weekBounds('2026-W54')).toThrow(/ISO weeks 1\.\.53/)
  })

  it('rejects a malformed week string', () => {
    expect(() => weekBounds('2026-13')).toThrow(/malformed ISO week string/)
  })
})
