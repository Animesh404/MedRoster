import { notFound } from 'next/navigation'
import type { Profession } from '@prisma/client'
import { auth } from '@/auth'
import { PageHero } from '@/components/page-hero'
import { SlotMeter } from '@/components/slot-meter'
import { StatTile } from '@/components/stat-tile'
import { ClaimButton } from '@/components/shift/claim-button'
import { AssignControl } from '@/components/shift/assign-control'
import { RemoveClaimButton } from '@/components/shift/remove-claim-button'
import { EditDialog } from '@/components/shift/edit-dialog'
import { DeleteDialog } from '@/components/shift/delete-dialog'
import { ActivityTimeline, type ActivityItem } from '@/components/shift/activity-timeline'
import { WeekRealtimeSync } from '@/components/realtime/week-realtime-sync'
import { can, type Principal } from '@/lib/auth/permissions'
import { computeCoverage } from '@/lib/coverage'
import { buildMeter, STATUS_STYLES } from '@/lib/ui/tokens'
import { PROFESSIONS, PROFESSION_LABELS } from '@/lib/domain/profession'
import { durationMinutes, isoWeekOf } from '@/lib/domain/time'
import type { OutboxEvent } from '@/lib/contracts/events'
import { internalFetch } from '@/lib/server/internal-fetch'

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'
const dateFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: CLINIC_TZ })
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CLINIC_TZ })

interface Claim {
  id: number
  userId: number
  assignedById: number | null
  createdAt: string
  user: { id: number; name: string; profession: Profession | null }
}

interface ShiftDetail {
  id: number
  startsAt: string
  endsAt: string
  version: number
  requirements: { id: number; profession: Profession; requiredCount: number }[]
  claims: Claim[]
}

interface StaffMember { id: number; name: string; profession: Profession | null }

function requirementsRecord(requirements: ShiftDetail['requirements']): Record<Profession, number> {
  const out: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  for (const r of requirements) out[r.profession] = r.requiredCount
  return out
}

function claimsRecord(claims: Claim[]): Record<Profession, number> {
  const out: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  for (const c of claims) if (c.user.profession) out[c.user.profession] += 1
  return out
}

/**
 * Builds the Activity timeline from two sources that never disagree by
 * construction: the shift's CURRENT claims (which carry `assignedById`, so
 * "claimed" and "assigned" are distinguishable) for who holds it now, and
 * the week topic's event history for what no longer shows up in the current
 * claim list at all — a release, a drop, or a retime.
 */
function buildActivity(shift: ShiftDetail, events: OutboxEvent[], staffById: Map<number, string>): ActivityItem[] {
  const items: ActivityItem[] = []

  for (const claim of shift.claims) {
    items.push({
      kind: claim.assignedById ? 'assigned' : 'claimed',
      description: `${claim.user.name}${claim.user.profession ? ` (${PROFESSION_LABELS[claim.user.profession]})` : ''} ${claim.assignedById ? 'was assigned' : 'claimed this shift'}.`,
      at: claim.createdAt,
    })
  }

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>
    if (Number(payload.shiftId) !== shift.id) continue

    if (event.type === 'shift.unclaimed') {
      const userId = Number(payload.userId)
      items.push({
        kind: 'removed',
        description: `${staffById.get(userId) ?? `Staff #${userId}`} released this shift.`,
        at: event.createdAt ?? null,
      })
    } else if (event.type === 'shift.claims_dropped') {
      const dropped = payload.dropped as { userId: number; name: string; reason: string }[]
      for (const d of dropped) {
        items.push({
          kind: 'removed',
          description: `${d.name} was dropped — ${d.reason}`,
          at: event.createdAt ?? null,
        })
      }
    } else if (event.type === 'shift.edited') {
      const startsAt = String(payload.startsAt)
      const endsAt = String(payload.endsAt)
      items.push({
        kind: 'moved',
        description: `Shift retimed to ${dateFmt.format(new Date(startsAt))}, ${clock.format(new Date(startsAt))}–${clock.format(new Date(endsAt))}.`,
        at: event.createdAt ?? null,
      })
    }
  }

  // Newest first; items with no timestamp (shouldn't happen post-Task-19,
  // but the schema field is optional for older data) sort last.
  return items.sort((a, b) => {
    if (a.at === null) return 1
    if (b.at === null) return -1
    return new Date(b.at).getTime() - new Date(a.at).getTime()
  })
}

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const shiftId = Number(id)
  if (!Number.isInteger(shiftId) || shiftId < 1) notFound()

  const session = await auth()
  if (!session?.user) notFound() // middleware already guards this route; defence in depth
  const principal: Principal = { id: session.user.id, role: session.user.role, profession: session.user.profession }

  const shiftRes = await internalFetch(`/api/shifts/${shiftId}`)
  if (shiftRes.status === 404) notFound()
  if (!shiftRes.ok) throw new Error(`Failed to load shift ${shiftId} (${shiftRes.status})`)
  const shift = (await shiftRes.json()) as ShiftDetail

  const isoWeek = isoWeekOf(new Date(shift.startsAt))

  const [staffRes, eventsRes] = await Promise.all([
    internalFetch('/api/staff?limit=100'),
    internalFetch(`/api/events/since?topic=${encodeURIComponent(`week:${isoWeek}`)}&id=0&limit=500`),
  ])
  const staffPage = staffRes.ok ? (await staffRes.json()) as { items: StaffMember[] } : { items: [] }
  const eventsBody = eventsRes.ok
    ? (await eventsRes.json()) as { events: OutboxEvent[] }
    : { events: [] }

  const staffById = new Map(staffPage.items.map((s) => [s.id, s.name] as const))
  const requirements = requirementsRecord(shift.requirements)
  const claims = claimsRecord(shift.claims)
  const { status, missing } = computeCoverage(requirements, claims)
  const totalRequired = PROFESSIONS.reduce((sum, p) => sum + requirements[p], 0)
  const totalFilled = PROFESSIONS.reduce((sum, p) => sum + Math.min(requirements[p], claims[p]), 0)
  const gaugeValue = totalRequired > 0 ? totalFilled / totalRequired : 1
  const gaugeClassName = status === 'PARTIAL' ? 'text-amber-300' : status === 'EMPTY' ? 'text-rose-300' : 'text-white'

  const hours = durationMinutes({ startsAt: new Date(shift.startsAt), endsAt: new Date(shift.endsAt) }) / 60
  const missingRoles = PROFESSIONS.filter((p) => missing[p] > 0)

  const myClaim = shift.claims.find((c) => c.userId === principal.id)
  const activity = buildActivity(shift, eventsBody.events, staffById)

  return (
    <WeekRealtimeSync isoWeek={isoWeek}>
      <div className="space-y-8">
        <PageHero
          eyebrow={`Shift · ${STATUS_STYLES[status].label}`}
          title={dateFmt.format(new Date(shift.startsAt))}
          gauge={{ value: gaugeValue, label: `${Math.round(gaugeValue * 100)}% of required headcount filled`, className: gaugeClassName }}
        >
          <p className="tabular text-lg text-white/90">
            {clock.format(new Date(shift.startsAt))}–{clock.format(new Date(shift.endsAt))} · {hours % 1 === 0 ? hours : hours.toFixed(1)}h
          </p>
          <p className="text-sm text-white/80">
            {status === 'FULL' ? 'Fully staffed' : `Needs ${missingRoles.map((p) => `${missing[p]} ${PROFESSION_LABELS[p].toLowerCase()}${missing[p] === 1 ? '' : 's'}`).join(', ')}`}
          </p>
        </PageHero>

        <section aria-labelledby="shift-stats-heading" className="space-y-4">
          <h2 id="shift-stats-heading" className="sr-only">Shift statistics</h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Filled" value={`${totalFilled} / ${totalRequired}`} />
            <StatTile label="Open slots" value={PROFESSIONS.reduce((s, p) => s + missing[p], 0)} />
            <StatTile label="Holding it" value={shift.claims.length} />
            <StatTile label="Duration" value={`${hours % 1 === 0 ? hours : hours.toFixed(1)}h`} />
          </dl>
        </section>

        <section aria-labelledby="requirements-heading" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id="requirements-heading" className="text-lg font-semibold text-foreground">Staffing by role</h2>
            {can(principal, 'shift:update') || can(principal, 'shift:delete') ? (
              <div className="flex gap-2">
                {can(principal, 'shift:update') && (
                  <EditDialog shiftId={shift.id} startsAt={shift.startsAt} endsAt={shift.endsAt} requirements={requirements} />
                )}
                {can(principal, 'shift:delete') && <DeleteDialog shiftId={shift.id} />}
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            {PROFESSIONS.filter((p) => requirements[p] > 0).map((profession) => {
              const rowRequirements: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
              rowRequirements[profession] = requirements[profession]
              const rowClaims: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
              rowClaims[profession] = claims[profession]
              const holders = shift.claims.filter((c) => c.user.profession === profession)
              const candidates = staffPage.items.filter((s) => s.profession === profession && !holders.some((h) => h.userId === s.id))
              const iCanClaimThis = principal.profession === profession && can(principal, 'claim:create:self')

              return (
                <div key={profession} className="space-y-2 rounded-card border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SlotMeter segments={buildMeter(rowRequirements, rowClaims)} />
                    <span className="tabular text-sm text-muted-foreground">
                      {claims[profession]} of {requirements[profession]}
                    </span>
                  </div>

                  {holders.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {holders.map((h) => (
                        <li key={h.userId} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                          {h.user.name}
                          {h.userId === principal.id ? (
                            <span className="text-muted-foreground">(you)</span>
                          ) : can(principal, 'claim:delete:any') ? (
                            <RemoveClaimButton shiftId={shift.id} userId={h.userId} name={h.user.name} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}

                  {iCanClaimThis && (
                    <ClaimButton shiftId={shift.id} claimed={Boolean(myClaim)} userId={principal.id} />
                  )}

                  {can(principal, 'claim:create:any') && (
                    <AssignControl shiftId={shift.id} profession={profession} candidates={candidates} />
                  )}
                </div>
              )
            })}
          </div>

          {principal.profession && requirements[principal.profession] === 0 && (
            <p className="text-sm text-muted-foreground">
              This shift does not need a {PROFESSION_LABELS[principal.profession].toLowerCase()}, so there is nothing here for you to claim.
            </p>
          )}
        </section>

        <section aria-labelledby="activity-heading" className="space-y-3">
          <h2 id="activity-heading" className="text-lg font-semibold text-foreground">Activity</h2>
          <ActivityTimeline items={activity} />
        </section>
      </div>
    </WeekRealtimeSync>
  )
}
