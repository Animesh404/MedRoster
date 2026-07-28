import Link from 'next/link'
import type { Profession } from '@prisma/client'
import { StatDot } from '@/components/stat-dot'
import { SlotMeter } from '@/components/slot-meter'
import { computeCoverage } from '@/lib/coverage'
import { PROFESSION_LABELS, PROFESSIONS } from '@/lib/domain/profession'
import { buildMeter } from '@/lib/ui/tokens'
import type { WeekShift } from '@/lib/contracts/week'

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
})

/** "Needs 1 nurse, 2 doctors" — exactly which roles are still short, in a stable order. */
function missingRolesLabel(missing: Record<Profession, number>): string {
  const parts = PROFESSIONS.filter((p) => missing[p] > 0).map((p) => {
    const n = missing[p]
    const label = PROFESSION_LABELS[p].toLowerCase()
    return `${n} ${label}${n === 1 ? '' : 's'}`
  })
  return parts.length === 0 ? '' : `Needs ${parts.join(', ')}`
}

/**
 * A single shift's card: time, status (dot + label, never colour alone),
 * the slot meter, and — the whole point of the screen — exactly which roles
 * are still missing, not just that something is missing.
 */
export function ShiftCard({
  shift,
  claims,
}: {
  shift: WeekShift
  claims: Record<Profession, number>
}) {
  const { status, missing } = computeCoverage(shift.requirements, claims)
  const segments = buildMeter(shift.requirements, claims)

  return (
    <article className="rounded-card border border-border bg-card p-3 transition-shadow hover:shadow-md">
      <Link
        href={`/shifts/${shift.id}`}
        className="block space-y-2 rounded-[calc(var(--radius-card)-2px)] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="tabular text-sm font-medium">
            {clock.format(new Date(shift.startsAt))}–{clock.format(new Date(shift.endsAt))}
          </span>
          <StatDot status={status} />
        </div>

        <SlotMeter segments={segments} />

        <p className="text-xs text-muted-foreground">
          {status === 'FULL' ? (
            'Fully staffed'
          ) : (
            <span className="font-medium text-foreground">{missingRolesLabel(missing)}</span>
          )}
        </p>
      </Link>
    </article>
  )
}
