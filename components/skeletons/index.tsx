import { Skeleton } from '@/components/ui/skeleton'
import { SlotMeterSkeleton } from '@/components/slot-meter'

/**
 * Skeletons are built from the same layout primitives and the same fixed
 * dimensions as the real components — the same `.slot` circles, the same
 * day-spine bar — so hydration swaps content in without shifting anything on
 * the page.
 */
export function ShiftCardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading shift"
      className="space-y-2 rounded-card border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
      </div>
      <SlotMeterSkeleton />
    </div>
  )
}

export function WeekGridSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-7">
      {Array.from({ length: 7 }, (_, day) => (
        <div key={day} data-skeleton-day className="space-y-3">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-20" />
            {/* Day-spine placeholder — the real grid rings this bar in the
                day's worst STATUS_STYLES colour (`spine`); while loading it
                just pulses neutral. */}
            <Skeleton className="h-1 w-full rounded-full" />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <ShiftCardSkeleton key={i} />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Loading placeholder for the coverage dashboard's page-hero band — same
 * `.hero-gradient` shape and a circle standing in for the `RadialGauge`, so
 * the gradient doesn't pop in a beat after everything else.
 */
function DashboardHeroSkeleton() {
  return (
    <div className="hero-gradient flex flex-col gap-6 rounded-[18px] px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-10 sm:py-10">
      <div className="space-y-3">
        <Skeleton className="h-3 w-40 bg-white/20" />
        <Skeleton className="h-8 w-64 bg-white/20" />
        <Skeleton className="h-7 w-72 bg-white/20" />
      </div>
      <Skeleton className="h-24 w-24 shrink-0 rounded-full bg-white/20" />
    </div>
  )
}

/**
 * The whole dashboard's loading state: hero, the analytics strip (stat
 * tiles in both their tile-grid and collapsed-row forms, and the two
 * single-hue bar charts), then the week grid. Mirrors the real page's
 * sections 1:1 so nothing shifts position when the real data swaps in.
 */
export function DashboardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading coverage dashboard" className="space-y-8">
      <DashboardHeroSkeleton />

      <div className="space-y-4">
        <div className="hidden gap-3 md:grid md:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-11 w-full rounded-card md:hidden" />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Skeleton className="h-48 rounded-card" />
          <Skeleton className="h-48 rounded-card" />
        </div>
      </div>

      <WeekGridSkeleton />
    </div>
  )
}

export function ImportReportSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading import report" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}
