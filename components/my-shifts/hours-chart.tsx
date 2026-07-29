export interface WeekHours {
  isoWeek: string
  weekStart: string // ISO date, Monday
  hours: number
  isCurrent: boolean
}

const weekLabelFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * The my-shifts page's hours-per-week bar chart. Plain flex/CSS, no charting
 * library — same approach `components/week-grid/coverage-charts.tsx` takes.
 * Bars grow from their baseline once, staggered 40ms apart, purely via a CSS
 * animation on the element itself (`.grow-from-baseline` in globals.css) —
 * it fires on first DOM insertion and never replays on a data refresh, so
 * "on mount only" holds without any extra client-side bookkeeping.
 */
export function HoursChart({ weeks }: { weeks: WeekHours[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.hours))

  return (
    <figure className="rounded-card border border-border bg-card p-4">
      <figcaption className="text-sm font-semibold text-foreground">Hours per week</figcaption>
      <div className="mt-4 flex items-end gap-2">
        {weeks.map((week, i) => {
          const pct = week.hours > 0 ? Math.max(4, (week.hours / max) * 100) : 2
          return (
            <div
              key={week.isoWeek}
              role="group"
              aria-label={`Week of ${weekLabelFmt.format(new Date(week.weekStart))}: ${week.hours} hour${week.hours === 1 ? '' : 's'}${week.isCurrent ? ' (this week)' : ''}`}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <span aria-hidden className="tabular text-xs font-medium text-foreground">{week.hours}</span>
              <div aria-hidden className="flex h-28 w-full items-end justify-center overflow-hidden">
                <span
                  className="grow-from-baseline w-full max-w-7 rounded-t-sm bg-brand-primary"
                  style={{ height: `${pct}%`, animationDelay: `${i * 40}ms` }}
                />
              </div>
              <span aria-hidden className={`text-[0.6875rem] ${week.isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                {weekLabelFmt.format(new Date(week.weekStart))}
              </span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}
