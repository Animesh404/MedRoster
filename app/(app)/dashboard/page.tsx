import { Suspense } from 'react'
import Link from 'next/link'
import { headers } from 'next/headers'
import { PageHero } from '@/components/page-hero'
import { DashboardSkeleton } from '@/components/skeletons'
import { CoverageCharts } from '@/components/week-grid/coverage-charts'
import { StatTiles } from '@/components/week-grid/stat-tiles'
import { WeekGrid } from '@/components/week-grid/week-grid'
import { WeekPicker } from '@/components/week-grid/week-picker'
import { WeekRealtimeSync } from '@/components/realtime/week-realtime-sync'
import { computeWeekAnalytics } from '@/lib/dashboard/week-analytics'
import { decodeWeek, isoWeekParamSchema, type CompressedWeek } from '@/lib/contracts/week'
import { isoWeekOf, weekBounds } from '@/lib/domain/time'
import { STATUS_STYLES } from '@/lib/ui/tokens'

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'
const dayMonthFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: CLINIC_TZ })
const dayMonthYearFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: CLINIC_TZ,
})

/** "28 July – 3 August 2026" — `end` is the exclusive next-Monday bound. */
function weekRangeLabel(start: Date, end: Date): string {
  const lastDay = new Date(end)
  lastDay.setUTCDate(lastDay.getUTCDate() - 1)
  return `${dayMonthFmt.format(start)} – ${dayMonthYearFmt.format(lastDay)}`
}

/**
 * Falls back to the current week for anything that isn't a shape-valid ISO
 * week string — a missing param, a typo, garbage from a hand-edited URL.
 * Shape-valid-but-out-of-range weeks (e.g. "2025-W53") pass this check and
 * are instead caught by `weekBounds` inside `DashboardContent`, which is
 * where the "degrade gracefully" behaviour lives.
 */
function resolveRequestedWeek(raw: string | undefined): string {
  if (raw && isoWeekParamSchema.safeParse(raw).success) return raw
  return isoWeekOf(new Date())
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>
}) {
  const params = await searchParams
  const isoWeek = resolveRequestedWeek(params.week)

  return (
    <Suspense key={isoWeek} fallback={<DashboardSkeleton />}>
      <DashboardContent isoWeek={isoWeek} />
    </Suspense>
  )
}

async function DashboardContent({ isoWeek }: { isoWeek: string }) {
  let bounds: { start: Date; end: Date }
  try {
    bounds = weekBounds(isoWeek)
  } catch {
    // Shape-valid, but the year doesn't have that many ISO weeks (e.g.
    // "2025-W53") — the same case the API maps to 400 (§API route). Caught
    // here too so a hand-typed URL never reaches the fetch below at all.
    return <InvalidWeekNotice isoWeek={isoWeek} />
  }

  const requestHeaders = await headers()
  const host = requestHeaders.get('host')
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http'
  const cookie = requestHeaders.get('cookie') ?? ''

  const res = await fetch(`${proto}://${host}/api/weeks/${isoWeek}`, {
    headers: { cookie },
    cache: 'no-store',
  })

  if (!res.ok) {
    if (res.status === 400) return <InvalidWeekNotice isoWeek={isoWeek} />
    throw new Error(`Failed to load week ${isoWeek} (${res.status})`)
  }

  const compressed = (await res.json()) as CompressedWeek
  const week = decodeWeek(compressed)
  const analytics = computeWeekAnalytics(week, isoWeek)
  const gaugePercent = Math.round(analytics.gaugeValue * 100)

  return (
    // Wired into realtime (CRITICAL-1) so the plan's own acceptance
    // scenario — "a nurse claims a shift, the manager's dashboard card
    // updates without refresh" — actually happens: this is a plain server
    // component with no client-held `WeekView` to reconcile, so `router.refresh()`
    // re-running it against fresh data on the next non-echo event IS the
    // reconciliation strategy (same as `/shifts/[id]`).
    <WeekRealtimeSync isoWeek={isoWeek}>
      <div className="space-y-8">
        <PageHero
          eyebrow={`Coverage · ${isoWeek}`}
          title={weekRangeLabel(bounds.start, bounds.end)}
          gauge={{
            value: analytics.gaugeValue,
            label: `${gaugePercent}% of required headcount filled this week`,
          }}
        >
          <WeekPicker isoWeek={isoWeek} />
          <ul className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-sm text-white/90">
            <li>
              <span aria-hidden>{STATUS_STYLES.FULL.glyph}</span> {STATUS_STYLES.FULL.label}{' '}
              <span className="tabular font-semibold">{analytics.fullCount}</span>
            </li>
            <li>
              <span aria-hidden>{STATUS_STYLES.PARTIAL.glyph}</span> {STATUS_STYLES.PARTIAL.label}{' '}
              <span className="tabular font-semibold">{analytics.partialCount}</span>
            </li>
            <li>
              <span aria-hidden>{STATUS_STYLES.EMPTY.glyph}</span> {STATUS_STYLES.EMPTY.label}{' '}
              <span className="tabular font-semibold">{analytics.emptyCount}</span>
            </li>
          </ul>
        </PageHero>

        <section aria-labelledby="analytics-heading" className="space-y-4">
          <h2 id="analytics-heading" className="sr-only">
            Coverage analytics
          </h2>
          <StatTiles analytics={analytics} />
          <CoverageCharts analytics={analytics} />
        </section>

        <section aria-labelledby="week-grid-heading" className="space-y-4">
          <h2 id="week-grid-heading" className="text-lg font-semibold text-foreground">
            This week&rsquo;s shifts
          </h2>
          <WeekGrid week={week} />
        </section>
      </div>
    </WeekRealtimeSync>
  )
}

/**
 * The fallback for a shape-valid ISO week that doesn't exist for its year
 * (`weekBounds` throws — see lib/domain/time.ts). Prev/next in `WeekPicker`
 * can never generate one of these by construction, so the only way here is
 * a hand-edited or bookmarked URL — hence a plain recovery link rather than
 * a dead end.
 */
function InvalidWeekNotice({ isoWeek }: { isoWeek: string }) {
  const currentWeek = isoWeekOf(new Date())
  return (
    <div className="hero-gradient space-y-4 rounded-[18px] px-6 py-8 text-white sm:px-10 sm:py-10">
      <p className="font-mono text-xs font-semibold tracking-[0.2em] text-white/70 uppercase">Coverage</p>
      <h1 className="font-display text-2xl font-semibold text-balance sm:text-3xl">That week doesn&rsquo;t exist</h1>
      <p className="max-w-prose text-white/85">
        &ldquo;{isoWeek}&rdquo; isn&rsquo;t a real ISO week — the year it names doesn&rsquo;t have that many weeks.
      </p>
      <Link
        href={`/dashboard?week=${currentWeek}`}
        className="inline-flex items-center rounded-lg bg-white/15 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        Go to the current week
      </Link>
    </div>
  )
}
