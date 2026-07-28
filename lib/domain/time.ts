export interface Interval { startsAt: Date; endsAt: Date }

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'

/**
 * Offset in minutes that the clinic timezone is ahead of UTC at the given instant.
 * Derived by formatting the instant in the clinic zone and diffing against UTC —
 * this is DST-correct without pulling in a date library.
 */
function tzOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  )
  return (asUtc - at.getTime()) / 60_000
}

/**
 * Converts a clinic-local wall-clock date+time to the UTC instant it denotes.
 * `date` is "yyyy-mm-dd", `time` is "HH:MM", both as written on the roster.
 *
 * DST edge behaviour (empirically verified, deterministic, not a bug):
 * - Ambiguous fall-back hour (e.g. 01:30 on 2026-10-25, which occurs twice as
 *   clocks go back) resolves to the LATER occurrence — the post-transition
 *   GMT reading — because the second pass re-probes the offset at `guess`,
 *   which by then already reflects the new (GMT) offset.
 * - Nonexistent spring-forward hour (e.g. 01:30 on 2026-03-29, which never
 *   occurs as clocks jump from 01:00 GMT to 02:00 BST) forward-snaps: the
 *   two-pass probe lands on the UTC instant that, read back in the clinic
 *   zone, shows as 02:30 BST — i.e. the wall time is pushed forward by the
 *   skipped hour rather than rejected.
 */
export function clinicWallTimeToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!)
  // Two passes: the offset itself depends on the instant, which we only know approximately.
  let guess = new Date(naive - tzOffsetMinutes(new Date(naive)) * 60_000)
  guess = new Date(naive - tzOffsetMinutes(guess) * 60_000)
  return guess
}

/** Half-open [start, end) overlap: shifts that merely touch do not conflict. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

export function durationMinutes(a: Interval): number {
  return (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

export interface ShiftWindow {
  startsAt: Date
  endsAt: Date
  rolledOverToNextDay: boolean
}

/**
 * Resolves a clinic-local date plus start/end wall times into UTC instants.
 *
 * An end at or before the start means the shift runs into the next day; an
 * explicit `endsNextDay` (the importer's "+1" suffix) forces the same rollover.
 * This is the SINGLE definition of that rule — the importer and the shift API
 * both call it, so a shift created through the UI and one imported from CSV can
 * never disagree about what "22:00-06:00" means.
 */
export function resolveShiftWindow(
  date: string,
  startTime: string,
  endTime: string,
  endsNextDay = false,
): ShiftWindow {
  const [sh, sm] = startTime.split(':').map(Number)
  const [eh, em] = endTime.split(':').map(Number)

  const rolledOverToNextDay = endsNextDay || eh! * 60 + em! <= sh! * 60 + sm!
  const endDate = rolledOverToNextDay ? addDays(date, 1) : date

  return {
    startsAt: clinicWallTimeToUtc(date, startTime),
    endsAt: clinicWallTimeToUtc(endDate, endTime),
    rolledOverToNextDay,
  }
}

const clinicDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * ISO-8601 week, e.g. "2026-W33". Weeks start Monday; week 1 contains the first Thursday.
 *
 * The instant is first mapped to its clinic-local calendar date. Without this, an
 * instant near clinic-local midnight (e.g. 2026-08-09T23:00Z, which is 2026-08-10
 * 00:00 BST) would be bucketed by its UTC calendar day and land in the wrong week —
 * exactly the kind of off-by-one that would corrupt week-bounds round-tripping.
 */
export function isoWeekOf(d: Date): string {
  const [y, m, day] = clinicDateFmt.format(d).split('-').map(Number)
  const t = new Date(Date.UTC(y!, m! - 1, day!))
  const dayNum = t.getUTCDay() || 7          // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)  // move to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * Number of ISO-8601 weeks in a given year — either 52 or 53.
 *
 * A year has 53 ISO weeks iff 1 January falls on a Thursday, or the year is
 * a leap year and 1 January falls on a Wednesday (equivalently: iff 31
 * December falls on a Thursday, or the year is a leap year and 31 December
 * falls on a Friday). Most years have 52.
 */
export function isoWeeksInYear(year: number): 52 | 53 {
  const jan1Day = new Date(Date.UTC(year, 0, 1)).getUTCDay() || 7 // Mon=1 … Sun=7
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return jan1Day === 4 || (isLeap && jan1Day === 3) ? 53 : 52
}

const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/

/** Monday 00:00 (clinic-local) through the following Monday 00:00, as UTC instants. */
export function weekBounds(isoWeek: string): { start: Date; end: Date } {
  const match = ISO_WEEK_RE.exec(isoWeek)
  if (!match) {
    throw new Error(`weekBounds: malformed ISO week string "${isoWeek}" (expected "YYYY-Www", e.g. "2026-W33")`)
  }
  const year = Number(match[1])
  const week = Number(match[2])
  const maxWeek = isoWeeksInYear(year)
  if (week < 1 || week > maxWeek) {
    throw new Error(
      `weekBounds: "${isoWeek}" is out of range — ${year} has ISO weeks 1..${maxWeek}`,
    )
  }
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1)
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7)

  const iso = (x: Date) => x.toISOString().slice(0, 10)
  const start = clinicWallTimeToUtc(iso(monday), '00:00')
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 7)
  const end = clinicWallTimeToUtc(iso(sunday), '00:00')
  return { start, end }
}
