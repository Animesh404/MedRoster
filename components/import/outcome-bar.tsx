export interface OutcomeCounts {
  accepted: number
  repaired: number
  merged: number
  rejected: number
  total: number
}

const SEGMENTS: { key: keyof Omit<OutcomeCounts, 'total'>; label: string; bar: string; dot: string }[] = [
  { key: 'accepted', label: 'Accepted', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  { key: 'repaired', label: 'Repaired', bar: 'bg-amber-500', dot: 'bg-amber-500' },
  { key: 'merged', label: 'Merged', bar: 'bg-sky-500', dot: 'bg-sky-500' },
  { key: 'rejected', label: 'Rejected', bar: 'bg-rose-500', dot: 'bg-rose-500' },
]

/**
 * Stacked outcome bar with DIRECT labels — every segment's count/percentage
 * is printed in the legend row below it, not hidden behind a hover tooltip
 * (a manager reading this on a shared screen or a printout gets nothing from
 * a `title` attribute). Colour is a second signal on top of the text, not
 * the only one — matches the SlotMeter's own rule (§responsiveness: status
 * never conveyed by colour alone).
 */
export function OutcomeBar({ counts }: { counts: OutcomeCounts }) {
  const total = Math.max(1, counts.total)

  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={SEGMENTS.map((s) => `${s.label}: ${counts[s.key]} of ${counts.total}`).join(', ')}
        className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
      >
        {SEGMENTS.map((s) => {
          const pct = (counts[s.key] / total) * 100
          return pct > 0 ? (
            <span key={s.key} aria-hidden className={`${s.bar} h-full`} style={{ width: `${pct}%` }} />
          ) : null
        })}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
            <span className="font-medium text-foreground">{s.label}</span>
            <span className="tabular text-muted-foreground">
              {counts[s.key]} ({counts.total > 0 ? Math.round((counts[s.key] / counts.total) * 100) : 0}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
