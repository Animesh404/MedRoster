import { cn } from '@/lib/utils'
import { meterLabel, type MeterSegment } from '@/lib/ui/tokens'

/**
 * The slot meter — MedRoster's signature element (§app/globals.css).
 *
 * A shift's staffing renders as literal slots, not a percentage: solid for a
 * held slot, hollow-with-rose-outline for the gap. The `.slot`/`.slot--filled`/
 * `.slot--empty` classes carry the shape; the wrapping span's text colour only
 * adds a second, non-load-bearing signal (emerald once a profession's rail is
 * full, rose while it still has a gap) so the meter still reads correctly in
 * greyscale or to a colour-blind viewer.
 */
export function SlotMeter({
  segments,
  className,
}: {
  segments: MeterSegment[]
  className?: string
}) {
  const label = meterLabel(segments)

  if (segments.length === 0) {
    return <span className={cn('text-xs text-muted-foreground', className)}>{label}</span>
  }

  return (
    <div role="img" aria-label={label} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {segments.map((segment) => {
        const complete = segment.filled >= segment.required
        return (
          <span
            key={segment.profession}
            className={cn(
              'inline-flex items-center gap-1',
              complete ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400',
            )}
          >
            <span aria-hidden className="font-mono text-[0.6875rem] font-semibold tracking-wide">
              {segment.mark}
            </span>
            <span aria-hidden className="inline-flex gap-0.5">
              {Array.from({ length: segment.required }, (_, i) => (
                <span key={i} className={cn('slot', i < segment.filled ? 'slot--filled' : 'slot--empty')} />
              ))}
            </span>
          </span>
        )
      })}
    </div>
  )
}

/**
 * Placeholder shape for the meter while a shift is loading — the exact same
 * `.slot` circles at the exact same size and spacing, just muted and pulsing,
 * so hydration never shifts the layout (§components/skeletons).
 *
 * `segments`/`slotsPerSegment` let a skeleton stand in for a specific shift
 * shape (e.g. echo a known requirement count) but default to a generic
 * two-profession, three-slot silhouette for the common case.
 */
export function SlotMeterSkeleton({
  segments = 2,
  slotsPerSegment = 3,
}: {
  segments?: number
  slotsPerSegment?: number
}) {
  return (
    <div aria-hidden className="flex animate-pulse flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground/60">
      {Array.from({ length: segments }, (_, s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className="h-[0.6875rem] w-2.5 rounded-sm bg-current opacity-50" />
          <span className="inline-flex gap-0.5">
            {Array.from({ length: slotsPerSegment }, (_, i) => (
              <span key={i} className="slot slot--empty" />
            ))}
          </span>
        </span>
      ))}
    </div>
  )
}
