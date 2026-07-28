import type { WeekAnalytics } from '@/lib/dashboard/week-analytics'

/**
 * The analytics strip's headline numbers. Two renderings of the same data
 * exist in the DOM at once, toggled purely by CSS breakpoint (no JS media
 * query) so there is nothing for hydration to reflow:
 *
 * - `md:` and up — three tiles (open slots / fully staffed / staff on rota),
 *   the full picture, room enough to spell each one out.
 * - below `md:` — a single compact inline row ("204 open · 7 full · 10
 *   empty") so the same information survives the width squeeze instead of
 *   being dropped (§responsiveness: status must stay visible at every width).
 */
export function StatTiles({ analytics }: { analytics: WeekAnalytics }) {
  return (
    <>
      <dl className="hidden gap-3 md:grid md:grid-cols-3">
        <StatTile label="Open slots" value={analytics.openSlots} />
        <StatTile label="Fully staffed" value={analytics.fullCount} />
        <StatTile label="Staff on rota" value={analytics.staffOnRota} />
      </dl>

      <p className="tabular rounded-card border border-border bg-card px-4 py-2.5 text-sm md:hidden">
        <span className="font-semibold text-foreground">{analytics.openSlots}</span>{' '}
        <span className="text-muted-foreground">open</span>
        <span aria-hidden className="px-1.5 text-muted-foreground">
          ·
        </span>
        <span className="font-semibold text-foreground">{analytics.fullCount}</span>{' '}
        <span className="text-muted-foreground">full</span>
        <span aria-hidden className="px-1.5 text-muted-foreground">
          ·
        </span>
        <span className="font-semibold text-foreground">{analytics.emptyCount}</span>{' '}
        <span className="text-muted-foreground">empty</span>
      </p>
    </>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-gradient-to-br from-brand-mid/10 to-card p-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="tabular mt-1 text-2xl font-semibold text-foreground">{value}</dd>
    </div>
  )
}
