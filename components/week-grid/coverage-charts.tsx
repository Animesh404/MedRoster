import { PROFESSION_LABELS } from '@/lib/domain/profession'
import type { WeekAnalytics } from '@/lib/dashboard/week-analytics'

// See components/week-grid/week-grid.tsx for why these formatters must read
// through the clinic zone rather than 'UTC' — the bucketed Date is the UTC
// instant of clinic-local midnight, not a UTC calendar date.
const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'
const weekdayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: CLINIC_TZ })
const weekdayLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: CLINIC_TZ })

/**
 * Both charts are deliberately single-hue (`--color-brand-primary`) with no
 * legend or per-series colour. Profession identity already comes from the
 * axis label, so colouring bars by profession would double-encode the same
 * fact — and every categorical palette tried collided with the reserved
 * status colours (nurse teal vs. "fully staffed" emerald measured ΔE 4.9,
 * under the 15 floor treated as a hard minimum for distinguishability).
 * Built from plain flex/CSS; no charting library.
 */
export function CoverageCharts({ analytics }: { analytics: WeekAnalytics }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <DayChart analytics={analytics} />
      <RoleChart analytics={analytics} />
    </div>
  )
}

function DayChart({ analytics }: { analytics: WeekAnalytics }) {
  const max = Math.max(1, ...analytics.byDay.map((d) => d.openSlots))

  return (
    <figure className="rounded-card border border-border bg-card p-4">
      <figcaption className="text-sm font-semibold text-foreground">Open slots by day</figcaption>
      <div className="mt-4 flex items-end gap-2">
        {analytics.byDay.map((day) => {
          const pct = day.openSlots > 0 ? Math.max(4, (day.openSlots / max) * 100) : 2
          return (
            <div
              key={day.date.toISOString()}
              role="group"
              aria-label={`${weekdayLong.format(day.date)}: ${day.openSlots} open slot${day.openSlots === 1 ? '' : 's'}`}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <span aria-hidden className="tabular text-xs font-medium text-foreground">
                {day.openSlots}
              </span>
              <div aria-hidden className="flex h-28 w-full items-end justify-center">
                <span
                  className="w-full max-w-7 rounded-t-sm bg-brand-primary transition-[height]"
                  style={{ height: `${pct}%` }}
                />
              </div>
              <span aria-hidden className="text-[0.6875rem] text-muted-foreground">
                {weekdayShort.format(day.date)}
              </span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}

function RoleChart({ analytics }: { analytics: WeekAnalytics }) {
  const max = Math.max(1, ...analytics.byRole.map((r) => r.openSlots))

  return (
    <figure className="rounded-card border border-border bg-card p-4">
      <figcaption className="text-sm font-semibold text-foreground">Open slots by role</figcaption>
      <div className="mt-4 space-y-3">
        {analytics.byRole.map((role) => {
          const pct = role.openSlots > 0 ? Math.max(3, (role.openSlots / max) * 100) : 1
          return (
            <div
              key={role.profession}
              role="group"
              aria-label={`${PROFESSION_LABELS[role.profession]}: ${role.openSlots} open slot${role.openSlots === 1 ? '' : 's'}`}
              className="flex items-center gap-3"
            >
              <span aria-hidden className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
                {PROFESSION_LABELS[role.profession]}
              </span>
              <div aria-hidden className="h-3 flex-1 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-brand-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span aria-hidden className="tabular w-8 shrink-0 text-right text-xs font-medium text-foreground">
                {role.openSlots}
              </span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}
