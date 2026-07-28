import type { CoverageStatus } from '@/lib/coverage'
import { STATUS_STYLES } from '@/lib/ui/tokens'
import { cn } from '@/lib/utils'

/**
 * A single coverage-status dot, pulled from the shared `STATUS_STYLES`
 * catalogue so a legend, a card and a day-spine can never disagree on what
 * "partial" looks like.
 *
 * `showLabel` (default `true`) prints the status word next to the dot, the
 * form that survives greyscale printing described in `lib/ui/tokens.ts`. Pass
 * `false` for a bare dot in a tight layout (e.g. a legend key) — the label is
 * still exposed to assistive tech via `role="img"`/`aria-label` on the dot
 * itself rather than dropped.
 */
export function StatDot({
  status,
  showLabel = true,
  className,
}: {
  status: CoverageStatus
  showLabel?: boolean
  className?: string
}) {
  const style = STATUS_STYLES[status]

  if (!showLabel) {
    return (
      <span
        role="img"
        aria-label={style.label}
        className={cn('inline-block h-2 w-2 rounded-full', style.dot, className)}
      />
    )
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', style.dot)} />
      <span className="text-xs text-muted-foreground">{style.label}</span>
    </span>
  )
}
