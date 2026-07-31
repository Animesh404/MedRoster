import type { ReactNode } from 'react'
import { currentSessionUser } from '@/lib/auth/session'
import { PageHero } from '@/components/page-hero'
import { StatTile } from '@/components/stat-tile'
import { ClaimButton } from '@/components/shift/claim-button'
import { HoursChart, type WeekHours } from '@/components/my-shifts/hours-chart'
import { DropNoticeBanner, type DropNotice } from '@/components/my-shifts/drop-notice'
import { WeekRealtimeSync } from '@/components/realtime/week-realtime-sync'
import { decodeWeek, type CompressedWeek, type WeekShift } from '@/lib/contracts/week'
import { durationMinutes, isoWeekOf, weekBounds } from '@/lib/domain/time'
import { PROFESSION_LABELS } from '@/lib/domain/profession'
import { internalFetch } from '@/lib/server/internal-fetch'
import { prisma } from '@/lib/db/client'
import { activeDropNotices } from '@/lib/rules/drop-notice'

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'
const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: CLINIC_TZ })
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CLINIC_TZ })

const WEEKS_BACK = 1
const WEEKS_FORWARD = 5

/** The window of ISO weeks this page looks at — one week back (so a very
 *  recent drop notice is still visible) through five weeks ahead (enough to
 *  make the hours-per-week chart and "upcoming" list meaningful). Walks real
 *  `Date` arithmetic the same way `WeekPicker`'s `step()` does, so crossing a
 *  year boundary can never produce an ISO week string that doesn't exist. */
function windowWeeks(now: Date): string[] {
  const monday = weekBounds(isoWeekOf(now)).start
  const weeks: string[] = []
  for (let i = -WEEKS_BACK; i <= WEEKS_FORWARD; i++) {
    const d = new Date(monday)
    d.setUTCDate(d.getUTCDate() + i * 7)
    weeks.push(isoWeekOf(d))
  }
  return weeks
}

/**
 * Nests one `<WeekRealtimeSync>` per visible week (CRITICAL-1) rather than
 * writing a new multi-topic subscription hook: this page already spans
 * `windowWeeks` (1 back / 5 forward), `WeekRealtimeSync` already renders
 * `{children}` unchanged and turns any non-echo event on ITS topic into a
 * `router.refresh()`, so reusing it as-is means a change on ANY visible
 * week — most importantly a `shift.claims_dropped`/`shift.deleted` naming
 * this user, the single most consequential event for a staff member —
 * refreshes the whole page. The trade-off, stated plainly: nesting means
 * `useRegisterMutation()` (used by this page's own release `ClaimButton`)
 * only ever reaches the INNERMOST instance's own-mutation set, so a
 * release's echo is only suppressed on that one topic rather than the
 * shift's actual topic — harmless here specifically because `ClaimButton`
 * already calls `router.refresh()` on success itself (IMPORTANT-6), so the
 * page is never depending on realtime echo suppression to reflect its own
 * action. A dedicated multi-topic hook would avoid that wrinkle but is a
 * materially bigger change for a page that has no per-shift mutations of
 * its own beyond release.
 */
function withWeekRealtimeSync(weeks: string[], children: ReactNode): ReactNode {
  return weeks.reduceRight(
    (acc, isoWeek) => <WeekRealtimeSync key={isoWeek} isoWeek={isoWeek}>{acc}</WeekRealtimeSync>,
    children,
  )
}

function countdown(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return 'starting now'
  const hours = Math.round(ms / 3_600_000)
  if (hours < 1) return 'in under an hour'
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `in ${days} day${days === 1 ? '' : 's'}`
}

export default async function MyShiftsPage() {
  const session = await currentSessionUser()
  if (!session) return null // middleware already guards this route
  const userId = session.principal.id
  const now = new Date()

  const weeks = windowWeeks(now)
  const currentWeek = isoWeekOf(now)

  // Only the week payloads. This used to also fetch `/api/events/since` for
  // all seven weeks, purely to reconstruct drop notices at render time; the
  // `DropNotice` table replaced that, and the fetches outlived their reader.
  const weekResponses = await Promise.all(weeks.map((w) => internalFetch(`/api/weeks/${w}`)))
  const decodedWeeks = await Promise.all(weekResponses.map(async (r) => (r.ok ? decodeWeek(await r.json() as CompressedWeek) : null)))

  const myShifts: (WeekShift & { isoWeek: string })[] = []
  const hoursPerWeek: WeekHours[] = []

  weeks.forEach((isoWeek, i) => {
    const week = decodedWeeks[i]
    if (!week) return
    const mine = week.shifts.filter((s) => s.claimantIds.includes(userId))
    for (const s of mine) myShifts.push({ ...s, isoWeek })

    const hours = mine.reduce((sum, s) => sum + durationMinutes({ startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) }) / 60, 0)
    hoursPerWeek.push({
      isoWeek, weekStart: weekBounds(isoWeek).start.toISOString(),
      hours: Math.round(hours * 10) / 10, isCurrent: isoWeek === currentWeek,
    })
  })

  myShifts.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
  const upcoming = myShifts.filter((s) => new Date(s.startsAt) > now)
  const nextShift = upcoming[0] ?? null

  // Drop notices — the shift no longer showing up in `myShifts` at all is
  // exactly what makes this the one thing a staff member cannot be left to
  // discover only by noticing a shift missing on the day (§my-shifts brief).
  // Read from `DropNotice`, not reconstructed from `EventOutbox`.
  //
  // Rebuilding these at render time is what made the outbox impossible to
  // prune: deleting an event deleted a notice a nurse might never have seen.
  // The row carries the shift's times as a snapshot, so a DELETED shift no
  // longer needs its times recovered by digging through event history either.
  const stored = await activeDropNotices(prisma, userId)
  const notices: DropNotice[] = stored.map((n) => ({
    id: n.id,
    shiftId: n.shiftId,
    reason: n.reason,
    at: n.createdAt.toISOString(),
    kind: n.kind === 'deleted' ? 'deleted' : 'dropped',
    shiftStartsAt: n.shiftStartsAt?.toISOString() ?? null,
    shiftEndsAt: n.shiftEndsAt?.toISOString() ?? null,
  }))

  const totalHoursWindow = Math.round(hoursPerWeek.reduce((sum, w) => sum + w.hours, 0) * 10) / 10
  const thisWeekHours = hoursPerWeek.find((w) => w.isCurrent)?.hours ?? 0

  return withWeekRealtimeSync(weeks, (
    <div className="space-y-8">
      <DropNoticeBanner notices={notices} />

      <PageHero eyebrow="My shifts" title={session.name}>
        <p className="text-white/90">
          {nextShift
            ? `Next up: ${dateFmt.format(new Date(nextShift.startsAt))}, ${clock.format(new Date(nextShift.startsAt))} — ${countdown(new Date(nextShift.startsAt), now)}.`
            : session.principal.profession === null
              ? 'Managers do not hold clinical shifts, so this page stays empty for you.'
              : 'Nothing scheduled in the next five weeks.'}
        </p>
      </PageHero>

      <section aria-labelledby="my-stats-heading" className="space-y-4">
        <h2 id="my-stats-heading" className="sr-only">My shift statistics</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Upcoming shifts" value={upcoming.length} />
          <StatTile label="Hours this week" value={thisWeekHours} />
          <StatTile label={`Hours, next ${WEEKS_FORWARD} weeks`} value={totalHoursWindow} />
        </dl>
        <HoursChart weeks={hoursPerWeek} />
      </section>

      <section aria-labelledby="my-upcoming-heading" className="space-y-3">
        <h2 id="my-upcoming-heading" className="text-lg font-semibold text-foreground">Upcoming shifts</h2>
        {upcoming.length === 0 ? (
          <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">
            {/* Telling a manager to "claim a shift" pointed them at the one action
                the rules refuse them — a shift requires a profession and they
                have none (PROFESSION_NOT_REQUIRED). */}
            {session.principal.profession === null
              ? 'Shifts are claimed by clinical staff. As a manager you assign them from the dashboard instead.'
              : 'You have nothing scheduled in this window. Visit the dashboard to claim a shift.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-card p-3">
                <a href={`/shifts/${shift.id}`} className="min-w-0 flex-1 space-y-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <p className="tabular text-sm font-medium text-foreground">
                    {dateFmt.format(new Date(shift.startsAt))} · {clock.format(new Date(shift.startsAt))}–{clock.format(new Date(shift.endsAt))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.principal.profession ? PROFESSION_LABELS[session.principal.profession] : 'Shift'} · {durationMinutes({ startsAt: new Date(shift.startsAt), endsAt: new Date(shift.endsAt) }) / 60}h
                  </p>
                </a>
                <ClaimButton shiftId={shift.id} claimed userId={userId} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  ))
}
