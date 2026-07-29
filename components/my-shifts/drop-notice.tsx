export interface DropNotice {
  shiftId: number
  reason: string
  at: string | null
  kind: 'dropped' | 'deleted'
  /** The dropped shift's OWN scheduled time — best-effort (see
   *  `app/(app)/my-shifts/page.tsx`'s `shiftTimeLabel`): resolved from the
   *  still-live `Shift` row when it exists, or from that shift's own event
   *  history (`shift.created`/`shift.edited`) when it doesn't (a deletion
   *  removes the `Shift` row but never its `EventOutbox` rows). `null` only
   *  when neither source has it — genuinely unknown, not just unfetched. */
  shiftStartsAt: string | null
  shiftEndsAt: string | null
}

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'

/** When this notice was recorded — i.e. when the drop happened, NOT the
 *  dropped shift's own time (MINOR-8: those are two different timestamps,
 *  and rendering only this one left a staff member unable to tell WHICH
 *  shift they lost). */
const reportedAtFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: CLINIC_TZ,
})
/** The dropped shift's own date/time — what the reader actually needs. */
const shiftDayFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: CLINIC_TZ,
})
const shiftTimeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CLINIC_TZ,
})

/** "Tue, 25 Aug · 20:00–22:00", or just the start time when the end isn't
 *  known (a bare `shift.created` fallback carries no `endsAt`), or `null`
 *  when this notice has no time information at all — the shiftId-only
 *  fallback the caller renders instead. */
function shiftRangeLabel(startsAt: string | null, endsAt: string | null): string | null {
  if (!startsAt) return null
  const day = shiftDayFmt.format(new Date(startsAt))
  const start = shiftTimeFmt.format(new Date(startsAt))
  const end = endsAt ? `–${shiftTimeFmt.format(new Date(endsAt))}` : ''
  return `${day} · ${start}${end}`
}

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
        {notices.map((n, i) => {
          const shiftLabel = shiftRangeLabel(n.shiftStartsAt, n.shiftEndsAt)
          return (
            <li key={i} className="text-sm text-rose-800 dark:text-rose-200">
              <span className="font-medium">{shiftLabel ?? `Shift #${n.shiftId}`}</span>
              {' — '}
              {n.kind === 'deleted' ? 'cancelled' : 'dropped'}: {n.reason}
              {n.at && (
                <span className="text-rose-600 dark:text-rose-400"> · reported {reportedAtFmt.format(new Date(n.at))}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
