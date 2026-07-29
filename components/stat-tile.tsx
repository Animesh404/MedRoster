import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A single headline-number tile — the same teal-tinted card
 * `components/week-grid/stat-tiles.tsx` uses for the dashboard, generalised
 * so the shift detail and my-shifts screens can reuse the exact look rather
 * than each inventing their own stat card.
 */
export function StatTile({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <div className={cn('rounded-card border border-border bg-gradient-to-br from-brand-mid/10 to-card p-4', className)}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 text-2xl font-semibold text-foreground">{value}</dd>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
