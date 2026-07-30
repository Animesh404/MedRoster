'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Profession } from '@prisma/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RequirementStepper } from '@/components/shift/requirement-stepper'
import { newMutationId } from '@/hooks/use-realtime'
import { PROFESSIONS, PROFESSION_LABELS } from '@/lib/domain/profession'

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

const PREVIEW_CAP = 366

/**
 * Client-side ONLY approximation of `occurrenceDates` in
 * `app/api/shifts/route.ts` — purely for the "what will be created" preview
 * panel below. The server re-derives this itself and is the sole source of
 * truth for what actually gets written; nothing here is trusted.
 */
function previewOccurrences(from: string, weekdays: number[], until: string): { dates: string[]; truncated: boolean } {
  const [fy, fm, fd] = from.split('-').map(Number)
  if (!fy || !fm || !fd || weekdays.length === 0) return { dates: [], truncated: false }
  const cursor = new Date(Date.UTC(fy, fm - 1, fd))
  const end = new Date(`${until}T00:00:00Z`)
  if (Number.isNaN(end.getTime()) || cursor > end) return { dates: [], truncated: false }

  const wanted = new Set(weekdays)
  const out: string[] = []
  let truncated = false
  while (cursor <= end) {
    if (out.length >= PREVIEW_CAP) { truncated = true; break }
    if (wanted.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return { dates: out, truncated }
}

const listFmt = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' })
const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

function requirementsSummary(requirements: Record<Profession, number>): string {
  const parts = PROFESSIONS.filter((p) => requirements[p] > 0).map((p) => {
    const n = requirements[p]
    const label = PROFESSION_LABELS[p].toLowerCase()
    return `${n} ${label}${n === 1 ? '' : 's'}`
  })
  return parts.length === 0 ? 'nobody yet' : listFmt.format(parts)
}

export function NewShiftForm() {
  const router = useRouter()
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const [date, setDate] = useState(today)
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('16:00')
  const [requirements, setRequirements] = useState<Record<Profession, number>>({ DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 })
  const [recurs, setRecurs] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [untilDate, setUntilDate] = useState(today)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = recurs ? previewOccurrences(date, weekdays, untilDate) : { dates: date ? [date] : [], truncated: false }
  const count = preview.dates.length
  const totalRequired = PROFESSIONS.reduce((sum, p) => sum + requirements[p], 0)

  function toggleWeekday(value: number) {
    setWeekdays((prev) => (prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value].sort()))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)

    const res = await fetch('/api/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date, startTime, endTime, requirements,
        ...(recurs ? { recurrence: { weekdays, untilDate } } : {}),
        mutationId: newMutationId(),
      }),
    })
    setSubmitting(false)

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setError(body?.error?.message ?? 'Could not create this shift. Please try again.')
      return
    }

    const body = await res.json().catch(() => null) as { ids: number[] } | null
    if (body && body.ids.length === 1 && !recurs) {
      router.push(`/shifts/${body.ids[0]}`)
    } else {
      router.push('/dashboard')
    }
    router.refresh()
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <section className="space-y-3 rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">When</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Date
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Starts
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Ends
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>
        </section>

        <section className="space-y-3 rounded-card border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Who&rsquo;s needed</h2>
          <div className="space-y-2">
            {PROFESSIONS.map((profession) => (
              <RequirementStepper
                key={profession}
                profession={profession}
                value={requirements[profession]}
                onChange={(next) => setRequirements((r) => ({ ...r, [profession]: next }))}
              />
            ))}
          </div>
        </section>

        <section className="space-y-3 rounded-card border border-border bg-card p-4">
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <input
              type="checkbox"
              checked={recurs}
              onChange={(e) => setRecurs(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Repeat this shift
          </label>

          {recurs && (
            <div className="space-y-3 pt-1">
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((wd) => (
                  <Button
                    key={wd.value}
                    type="button"
                    size="sm"
                    variant={weekdays.includes(wd.value) ? 'default' : 'outline'}
                    onClick={() => toggleWeekday(wd.value)}
                    aria-pressed={weekdays.includes(wd.value)}
                  >
                    {wd.label}
                  </Button>
                ))}
              </div>
              <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                Until
                <Input type="date" value={untilDate} min={date} onChange={(e) => setUntilDate(e.target.value)} className="max-w-48" />
              </label>
            </div>
          )}
        </section>

        {error && (
          <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
            {error}
          </p>
        )}

        <Button
          type="button"
          disabled={submitting || totalRequired === 0 || (recurs && weekdays.length === 0)}
          onClick={() => void submit()}
        >
          {submitting ? 'Creating…' : count > 1 ? `Create ${count} shifts` : 'Create shift'}
        </Button>
      </div>

      <aside className="h-fit space-y-3 rounded-card border border-border bg-gradient-to-br from-brand-mid/10 to-card p-4">
        <h2 className="text-sm font-semibold text-foreground">What this creates</h2>
        <p className="tabular text-4xl font-semibold text-brand-deep dark:text-brand-mid">{count}</p>
        <p className="text-sm text-foreground">
          {count === 0
            ? 'Nothing yet — pick a date and, if repeating, at least one weekday.'
            : recurs
              ? `${count} shift${count === 1 ? '' : 's'} every ${weekdays.map((d) => WEEKDAYS.find((w) => w.value === d)?.label).join('/')}, ${startTime}–${endTime}, from ${date} through ${untilDate}, needing ${requirementsSummary(requirements)}.`
              : `One shift on ${date}, ${startTime}–${endTime}, needing ${requirementsSummary(requirements)}.`}
        </p>
        {preview.truncated && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            That&rsquo;s more than this preview shows — narrow the range before creating.
          </p>
        )}
        {count > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              {/* "First 5" only when there are more than 5 — otherwise the list is all of them. */}
              {count > 5 ? 'First 5 dates' : count === 1 ? 'Date' : 'Dates'}
            </p>
            <ul className="tabular mt-1 space-y-0.5 text-sm text-foreground">
              {preview.dates.slice(0, 5).map((d) => (
                <li key={d}>{dateFmt.format(new Date(`${d}T00:00:00Z`))}</li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}
