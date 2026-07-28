import { describe, expect, it } from 'vitest'
import { computeWeekAnalytics } from '@/lib/dashboard/week-analytics'
import type { WeekView } from '@/lib/contracts/week'

const isoWeek = '2026-W33'

const view: WeekView = {
  isoWeek,
  staff: [
    { id: 1, name: 'Ivy Bell', profession: 'NURSE' },
    { id: 2, name: 'Sam Ortiz', profession: 'DOCTOR' },
  ],
  shifts: [
    // Monday — fully staffed.
    {
      id: 1, version: 0,
      startsAt: '2026-08-10T07:00:00.000Z', endsAt: '2026-08-10T15:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 },
      claimantIds: [1, 2],
    },
    // Tuesday — partially staffed (missing 1 nurse).
    {
      id: 2, version: 0,
      startsAt: '2026-08-11T07:00:00.000Z', endsAt: '2026-08-11T15:00:00.000Z',
      requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
      claimantIds: [1],
    },
    // Tuesday, second shift — nobody assigned.
    {
      id: 3, version: 0,
      startsAt: '2026-08-11T16:00:00.000Z', endsAt: '2026-08-11T23:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 0, RECEPTIONIST: 0 },
      claimantIds: [],
    },
  ],
}

describe('computeWeekAnalytics', () => {
  const analytics = computeWeekAnalytics(view, isoWeek)

  it('classifies every shift into exactly one status, matching computeCoverage', () => {
    expect(analytics.fullCount).toBe(1)
    expect(analytics.partialCount).toBe(1)
    expect(analytics.emptyCount).toBe(1)
  })

  it('sums missing headcount across the week, not a shift count', () => {
    // Tuesday: 1 missing nurse + 1 missing doctor = 2. Monday: 0.
    expect(analytics.openSlots).toBe(2)
  })

  it('counts staff on rota as the distinct claimants this week', () => {
    expect(analytics.staffOnRota).toBe(view.staff.length)
    expect(analytics.staffOnRota).toBe(2)
  })

  it('computes the gauge as filled/required across the whole week', () => {
    // required = 1+1 (Mon) + 2 (Tue nurse) + 1 (Tue doctor) = 5; filled = 2 (Mon) + 1 (Tue nurse) = 3.
    expect(analytics.gaugeValue).toBeCloseTo(3 / 5)
  })

  it("gives Tuesday the worse of its two shifts' statuses (EMPTY beats PARTIAL)", () => {
    const tuesday = analytics.byDay[1]!
    expect(tuesday.worstStatus).toBe('EMPTY')
    expect(tuesday.openSlots).toBe(2)
  })

  it('marks a day with nothing scheduled as NONE, not EMPTY', () => {
    const wednesday = analytics.byDay[2]!
    expect(wednesday.worstStatus).toBe('NONE')
    expect(wednesday.openSlots).toBe(0)
  })

  it('breaks missing headcount down by role', () => {
    const byRole = Object.fromEntries(analytics.byRole.map((r) => [r.profession, r.openSlots]))
    expect(byRole['NURSE']).toBe(1)
    expect(byRole['DOCTOR']).toBe(1)
    expect(byRole['RECEPTIONIST']).toBe(0)
  })
})

describe('computeWeekAnalytics on a week with no shifts', () => {
  it('reports a full gauge rather than dividing by zero', () => {
    const empty = computeWeekAnalytics({ isoWeek, staff: [], shifts: [] }, isoWeek)
    expect(empty.gaugeValue).toBe(1)
    expect(empty.openSlots).toBe(0)
    expect(empty.byDay.every((d) => d.worstStatus === 'NONE')).toBe(true)
  })
})
