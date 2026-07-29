import { auth } from '@/auth'
import { PageHero } from '@/components/page-hero'
import { StatTile } from '@/components/stat-tile'
import { ClaimButton } from '@/components/shift/claim-button'
import { HoursChart, type WeekHours } from '@/components/my-shifts/hours-chart'
import { DropNoticeBanner, type DropNotice } from '@/components/my-shifts/drop-notice'
import { decodeWeek, type CompressedWeek, type WeekShift } from '@/lib/contracts/week'
import { durationMinutes, isoWeekOf, weekBounds } from '@/lib/domain/time'
import { PROFESSION_LABELS } from '@/lib/domain/profession'
import { internalFetch } from '@/lib/server/internal-fetch'
import type { OutboxEvent } from '@/lib/contracts/events'

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
  const session = await auth()
  if (!session?.user) return null // middleware already guards this route
  const userId = session.user.id
  const now = new Date()

  const weeks = windowWeeks(now)
  const currentWeek = isoWeekOf(now)

  const [weekResponses, eventResponses] = await Promise.all([
    Promise.all(weeks.map((w) => internalFetch(`/api/weeks/${w}`))),
    Promise.all(weeks.map((w) => internalFetch(`/api/events/since?topic=${encodeURIComponent(`week:${w}`)}&id=0&limit=500`))),
  ])

  const decodedWeeks = await Promise.all(weekResponses.map(async (r) => (r.ok ? decodeWeek(await r.json() as CompressedWeek) : null)))
  const eventLists = await Promise.all(eventResponses.map(async (r) => (r.ok ? (await r.json() as { events: OutboxEvent[] }).events : [])))

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
  const notices: DropNotice[] = []
  weeks.forEach((_isoWeek, i) => {
    const events = eventLists[i] ?? []
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>

      if (event.type === 'shift.claims_dropped') {
        const dropped = payload.dropped as { userId: number; reason: string }[]
        const mine = dropped.find((d) => d.userId === userId)
        if (mine) notices.push({ shiftId: Number(payload.shiftId), reason: mine.reason, at: event.createdAt ?? null, kind: 'dropped' })
      } else if (event.type === 'shift.deleted') {
        const affected = payload.affectedUserIds as number[]
        if (affected.includes(userId)) {
          notices.push({
            shiftId: Number(payload.shiftId),
            reason: 'A manager deleted this shift.',
            at: event.createdAt ?? null,
            kind: 'deleted',
          })
        }
      }
    }
  })
  notices.sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())

  const totalHoursWindow = Math.round(hoursPerWeek.reduce((sum, w) => sum + w.hours, 0) * 10) / 10
  const thisWeekHours = hoursPerWeek.find((w) => w.isCurrent)?.hours ?? 0

  return (
    <div className="space-y-8">
      <DropNoticeBanner notices={notices} />

      <PageHero eyebrow="My shifts" title={session.user.name}>
        <p className="text-white/90">
          {nextShift
            ? `Next up: ${dateFmt.format(new Date(nextShift.startsAt))}, ${clock.format(new Date(nextShift.startsAt))} — ${countdown(new Date(nextShift.startsAt), now)}.`
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
            You have nothing scheduled in this window. Visit the dashboard to claim a shift.
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
                    {session.user.profession ? PROFESSION_LABELS[session.user.profession] : 'Shift'} · {durationMinutes({ startsAt: new Date(shift.startsAt), endsAt: new Date(shift.endsAt) }) / 60}h
                  </p>
                </a>
                <ClaimButton shiftId={shift.id} claimed userId={userId} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
