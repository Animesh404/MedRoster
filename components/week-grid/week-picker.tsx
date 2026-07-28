'use client'

import { useId } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { isoWeekOf, weekBounds } from '@/lib/domain/time'

// Client bundles only inline `NEXT_PUBLIC_*` env vars, so `process.env.CLINIC_TZ`
// is unavailable here; this hardcodes the same value `.env`/`CLINIC_TZ` carries
// server-side. Only used to format the date input's default value — a display
// nicety, not anything that gates correctness (the server is the source of
// truth for week boundaries).
const CLINIC_TZ = 'Europe/London'
const mondayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * Prev / Today / Next plus a date input that jumps to whatever week contains
 * the chosen date — the brief's "way to jump to any week." Every step goes
 * through real `Date` arithmetic (`weekBounds` → add/subtract days →
 * `isoWeekOf`), never string manipulation on the "Www" suffix, so stepping
 * across a year boundary (2026-W01 back to 2025-W53, or forward past a
 * 52-week year) can never produce an ISO week string that doesn't exist.
 *
 * The chosen week is pushed onto `?week=` so the view stays linkable and the
 * back button works (§ jump-to-week).
 */
export function WeekPicker({ isoWeek }: { isoWeek: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const inputId = useId()

  function goTo(nextIsoWeek: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('week', nextIsoWeek)
    router.push(`${pathname}?${params.toString()}`)
  }

  function step(days: number) {
    let anchor: Date
    try {
      anchor = weekBounds(isoWeek).start
    } catch {
      anchor = new Date()
    }
    const next = new Date(anchor)
    next.setUTCDate(next.getUTCDate() + days)
    goTo(isoWeekOf(next))
  }

  function jumpToDate(value: string) {
    if (!value) return
    const [y, m, d] = value.split('-').map(Number)
    if (!y || !m || !d) return
    // Noon UTC sidesteps any DST-edge ambiguity right at local midnight.
    goTo(isoWeekOf(new Date(Date.UTC(y, m - 1, d, 12))))
  }

  let mondayValue = ''
  try {
    mondayValue = mondayFmt.format(weekBounds(isoWeek).start)
  } catch {
    // isoWeek is malformed/out of range — leave the date input blank. The
    // page-level fallback already explains the situation; this control just
    // shouldn't throw while rendering alongside it.
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => step(-7)}>
        <span aria-hidden>←</span> Previous
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => goTo(isoWeekOf(new Date()))}>
        Today
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => step(7)}>
        Next <span aria-hidden>→</span>
      </Button>
      <label htmlFor={inputId} className="sr-only">
        Jump to the week containing this date
      </label>
      <Input
        id={inputId}
        type="date"
        defaultValue={mondayValue}
        onChange={(e) => jumpToDate(e.target.value)}
        className="h-7 w-auto border-white/30 bg-white/10 text-white placeholder:text-white/70 focus-visible:ring-white/50 [color-scheme:dark]"
      />
    </div>
  )
}
