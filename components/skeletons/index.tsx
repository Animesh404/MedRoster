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
