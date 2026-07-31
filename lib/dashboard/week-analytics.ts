import type { Profession } from '@prisma/client'
import { computeCoverage, type CoverageStatus } from '@/lib/coverage'
import { weekBounds } from '@/lib/domain/time'
import type { WeekShift, WeekView } from '@/lib/contracts/week'

const PROFESSIONS: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']

export interface DayBucket {
  date: Date
  shifts: WeekShift[]
}

/**
 * `'NONE'` is a fourth, dashboard-local state for a calendar day with no
 * scheduled shifts at all. It is deliberately NOT folded into
 * `CoverageStatus` — `computeCoverage`'s three values (§lib/coverage.ts)
 * describe a shift's staffing, and "nothing was scheduled" is a different
 * fact from "something was scheduled and nobody came." Rendering it as EMPTY
 * would make an ordinary day off read as a staffing failure.
 */
export type DaySpineStatus = CoverageStatus | 'NONE'

interface DayStat {
  date: Date
  openSlots: number
  worstStatus: DaySpineStatus
}

interface RoleStat {
  profession: Profession
  openSlots: number
}

export interface WeekAnalytics {
  /** Fraction (0..1) of required headcount actually filled across the week. */
  gaugeValue: number
  fullCount: number
  partialCount: number
  emptyCount: number
  /** Total missing headcount across every shift and profession — not a shift count. */
  openSlots: number
  /** Distinct staff members holding at least one claim this week. */
  staffOnRota: number
  byDay: DayStat[]
  byRole: RoleStat[]
}

function claimsFor(shift: WeekShift, professionOf: Map<number, Profession>): Record<Profession, number> {
  const claims: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  for (const id of shift.claimantIds) {
    const profession = professionOf.get(id)
    if (profession) claims[profession] += 1
  }
  return claims
}

/**
 * Buckets a week's shifts into its seven calendar days (Monday first), using
 * clinic-local day boundaries from `weekBounds` — the same boundary the API
 * uses to select the week's rows, so a shift can never land in the wrong
 * column here while correctly belonging to this week server-side.
 */
export function bucketByDay(week: WeekView, isoWeek: string): DayBucket[] {
  const { start } = weekBounds(isoWeek)
  return Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(start)
    dayStart.setUTCDate(dayStart.getUTCDate() + i)
    const dayEnd = new Date(dayStart)
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
    return {
      date: dayStart,
      shifts: week.shifts.filter((s) => {
        const at = new Date(s.startsAt)
        return at >= dayStart && at < dayEnd
      }),
    }
  })
}

const STATUS_RANK: Record<CoverageStatus, number> = { EMPTY: 2, PARTIAL: 1, FULL: 0 }

function worstOf(statuses: CoverageStatus[]): CoverageStatus {
  let worst: CoverageStatus = 'FULL'
  for (const status of statuses) {
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status
  }
  return worst
}

/**
 * The single definition of every number the dashboard shows — the gauge, the
 * status snapshot, the stat tiles and both charts all read from here, so
 * they cannot drift apart the way re-deriving each independently would risk.
 */
export function computeWeekAnalytics(week: WeekView, isoWeek: string): WeekAnalytics {
  const professionOf = new Map(week.staff.map((s) => [s.id, s.profession] as const))

  let totalRequired = 0
  let totalFilled = 0
  let fullCount = 0
  let partialCount = 0
  let emptyCount = 0
  const roleOpen: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

  for (const shift of week.shifts) {
    const claims = claimsFor(shift, professionOf)
    const { status, missing } = computeCoverage(shift.requirements, claims)

    if (status === 'FULL') fullCount += 1
    else if (status === 'PARTIAL') partialCount += 1
    else emptyCount += 1

    for (const profession of PROFESSIONS) {
      totalRequired += shift.requirements[profession]
      totalFilled += Math.min(shift.requirements[profession], claims[profession])
      roleOpen[profession] += missing[profession]
    }
  }

  const openSlots = PROFESSIONS.reduce((sum, p) => sum + roleOpen[p], 0)

  const byDay: DayStat[] = bucketByDay(week, isoWeek).map((bucket) => {
    let dayOpen = 0
    const statuses: CoverageStatus[] = []
    for (const shift of bucket.shifts) {
      const claims = claimsFor(shift, professionOf)
      const { status, missing } = computeCoverage(shift.requirements, claims)
      statuses.push(status)
      for (const profession of PROFESSIONS) dayOpen += missing[profession]
    }
    return {
      date: bucket.date,
      openSlots: dayOpen,
      worstStatus: statuses.length === 0 ? 'NONE' : worstOf(statuses),
    }
  })

  return {
    gaugeValue: totalRequired > 0 ? totalFilled / totalRequired : 1,
    fullCount,
    partialCount,
    emptyCount,
    openSlots,
    staffOnRota: week.staff.length,
    byDay,
    byRole: PROFESSIONS.map((profession) => ({ profession, openSlots: roleOpen[profession] })),
  }
}
