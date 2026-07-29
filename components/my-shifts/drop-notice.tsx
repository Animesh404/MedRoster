export interface DropNotice {
  shiftId: number
  reason: string
  at: string | null
  kind: 'dropped' | 'deleted'
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
})

/**
 * Leads the my-shifts page when non-empty (§ my-shifts). Being removed from
 * a shift is the most consequential thing that happens to a staff member,
 * so this renders ABOVE the hero content, not buried in an activity feed —
 * and deliberately carries NO animation: "a claim being dropped by an edit
 * gets no animation... bad news gets a static notice, not a flourish."
 */
export function DropNoticeBanner({ notices }: { notices: DropNotice[] }) {
  if (notices.length === 0) return null

  return (
    <div
      role="alert"
      className="space-y-2 rounded-[18px] border border-rose-300 bg-rose-50 px-5 py-4 dark:border-rose-800 dark:bg-rose-950"
    >
      <p className="text-sm font-semibold text-rose-900 dark:text-rose-100">
        {notices.length === 1 ? 'You were removed from a shift' : `You were removed from ${notices.length} shifts`}
      </p>
      <ul className="space-y-1.5">
        {notices.map((n, i) => (
          <li key={i} className="text-sm text-rose-800 dark:text-rose-200">
            {n.kind === 'deleted' ? 'A shift you held was cancelled' : 'You were dropped from a shift'} — {n.reason}
            {n.at && <span className="text-rose-600 dark:text-rose-400"> · {dateFmt.format(new Date(n.at))}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
