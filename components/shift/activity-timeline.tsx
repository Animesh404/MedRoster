import { cn } from '@/lib/utils'

type ActivityKind = 'claimed' | 'assigned' | 'moved' | 'removed'

export interface ActivityItem {
  kind: ActivityKind
  description: string
  at: string | null
}

const KIND_STYLES: Record<ActivityKind, { label: string; dot: string }> = {
  claimed: { label: 'Claimed', dot: 'bg-emerald-500' },
  assigned: { label: 'Assigned', dot: 'bg-brand-primary' },
  moved: { label: 'Moved', dot: 'bg-amber-500' },
  removed: { label: 'Removed', dot: 'bg-rose-500' },
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
})

/**
 * The shift detail page's Activity timeline: claimed / assigned / moved /
 * removed, newest first. Built server-side from two sources that never
 * disagree by construction — the shift's CURRENT claims (which carry
 * `assignedById`, so "claimed" and "assigned" are distinguishable) and the
 * week topic's event history (for what no longer shows up in the current
 * claim list at all: a release, a drop, or a retime). See
 * `app/(app)/shifts/[id]/page.tsx` for how the two are merged.
 */
export function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity recorded for this shift yet.</p>
  }

  return (
    <ol className="space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-3">
          <span aria-hidden className={cn('mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full', KIND_STYLES[item.kind].dot)} />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">
              <span className="font-medium">{KIND_STYLES[item.kind].label}.</span> {item.description}
            </p>
            {item.at && (
              <p className="tabular text-xs text-muted-foreground">{dateFmt.format(new Date(item.at))}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
