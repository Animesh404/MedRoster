import type { Profession } from '@prisma/client'
import { cn } from '@/lib/utils'
import { STATUS_STYLES } from '@/lib/ui/tokens'
import { bucketByDay, computeWeekAnalytics, type DaySpineStatus } from '@/lib/dashboard/week-analytics'
import type { WeekShift, WeekView } from '@/lib/contracts/week'
import { ShiftCard } from './shift-card'

// `day.date` (from `bucketByDay`) is the UTC instant of clinic-local midnight
// for that calendar day — formatting it with `timeZone: 'UTC'` would show the
// wrong weekday whenever the clinic is not at UTC+0 (e.g. BST), so every
// formatter here reads it back through the same clinic zone.
const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'
const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: CLINIC_TZ })
const dayShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: CLINIC_TZ })

/** Neutral spine for a day with nothing scheduled — distinct from EMPTY (§lib/dashboard/week-analytics.ts). */
const NONE_SPINE = 'bg-border'

function spineClassFor(status: DaySpineStatus): string {
  return status === 'NONE' ? NONE_SPINE : STATUS_STYLES[status].spine
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
 * Seven day columns ≥1280px, a ~4-visible horizontally-scrolling row from
 * 768px, and a full-width stacked list below that (§responsiveness). The
 * layout narrows; status and the missing-roles line inside each `ShiftCard`
 * never disappear at any width — only the column width changes.
 *
 * Each day carries a spine bar in its worst shift's status colour, so a
 * manager can read the shape of the week before opening a single card. The
 * per-day open-slot count and worst status come from `computeWeekAnalytics`
 * — the same aggregation the analytics strip above uses — rather than being
 * re-derived here, so the two can never disagree.
 */
export function WeekGrid({ week }: { week: WeekView }) {
  const professionOf = new Map(week.staff.map((s) => [s.id, s.profession] as const))
  const days = bucketByDay(week, week.isoWeek)
  const analytics = computeWeekAnalytics(week, week.isoWeek)

  return (
    <div
      className={cn(
        'flex flex-col gap-6',
        'md:flex-row md:gap-3 md:overflow-x-auto md:pb-2 md:[scrollbar-gutter:stable] md:snap-x md:snap-mandatory',
        'xl:grid xl:grid-cols-7 xl:gap-4 xl:overflow-visible xl:pb-0',
      )}
    >
      {days.map((day, i) => {
        const dayStat = analytics.byDay[i] ?? { openSlots: 0, worstStatus: 'NONE' as const }

        return (
          <section
            key={day.date.toISOString()}
            role="group"
            aria-label={`Day column, ${dayName.format(day.date)} ${dayShort.format(day.date)}`}
            className="space-y-3 md:w-40 md:shrink-0 md:snap-start xl:w-auto"
          >
            <DayHeader
              date={day.date}
              shiftCount={day.shifts.length}
              openSlots={dayStat.openSlots}
              worstStatus={dayStat.worstStatus}
            />

            <div className="space-y-3">
              {day.shifts.length === 0 ? (
                <p className="rounded-card border border-dashed border-border p-3 text-xs text-muted-foreground">
                  No shifts scheduled
                </p>
              ) : (
                day.shifts.map((shift) => (
                  <ShiftCard key={shift.id} shift={shift} claims={claimsFor(shift, professionOf)} />
                ))
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function DayHeader({
  date,
  shiftCount,
  openSlots,
  worstStatus,
}: {
  date: Date
  shiftCount: number
  openSlots: number
  worstStatus: DaySpineStatus
}) {
  return (
    <header className="sticky top-0 z-10 space-y-1.5 bg-background/90 pb-1 backdrop-blur">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{dayName.format(date)}</h3>
        <span className="tabular text-xs text-muted-foreground">{dayShort.format(date)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {shiftCount === 0 ? 'No shifts' : `${openSlots} open slot${openSlots === 1 ? '' : 's'}`}
      </p>
      <span aria-hidden className={cn('block h-1.5 w-full rounded-full', spineClassFor(worstStatus))} />
    </header>
  )
}
