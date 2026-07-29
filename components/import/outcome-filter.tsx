import Link from 'next/link'
import { cn } from '@/lib/utils'

const OUTCOMES = ['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED'] as const

const LABELS: Record<(typeof OUTCOMES)[number], string> = {
  ACCEPTED: 'Accepted', REPAIRED: 'Repaired', MERGED: 'Merged', REJECTED: 'Rejected',
}

/**
 * Filters the report's row table by outcome via `?outcome=`, so filtering
 * and the keyset pagination in `PaginationLinks` compose through the URL
 * rather than needing client state to agree with server-fetched pages.
 * Styled like tabs; semantically navigation (each option is a distinct URL),
 * so it's marked up as a nav rather than the ARIA tabs role.
 */
export function OutcomeFilter({ runId, active, counts }: {
  runId: number
  active: string | null
  counts: Record<(typeof OUTCOMES)[number], number>
}) {
  return (
    <nav aria-label="Filter by outcome" className="flex flex-wrap gap-1.5">
      <Link
        href={`/import/${runId}`}
        aria-current={active === null ? 'page' : undefined}
        className={cn(
          'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
          active === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
        )}
      >
        All
      </Link>
      {OUTCOMES.map((outcome) => (
        <Link
          key={outcome}
          href={`/import/${runId}?outcome=${outcome}`}
          aria-current={active === outcome ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            active === outcome ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
          )}
        >
          {LABELS[outcome]} <span className="tabular">({counts[outcome]})</span>
        </Link>
      ))}
    </nav>
  )
}
