import type { Profession } from '@prisma/client'
import { overlaps, type Interval } from '@/lib/domain/time'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { PROFESSION_LABELS } from '@/lib/domain/profession'

export interface ShiftForValidation {
  id: number
  startsAt: Date
  endsAt: Date
  requirements: { profession: Profession; requiredCount: number }[]
}

export interface UserForValidation {
  id: number
  profession: Profession | null
}

export interface ClaimContext {
  /** How many claims the shift already holds, per profession. */
  claimsByProfession: Record<Profession, number>
  /** Every OTHER shift this user already holds, as intervals. */
  userOtherShifts: Interval[]
}

const timeLabel = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
    timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
  }).format(d)

/**
 * The single arbiter of whether a person may hold a shift (§4.1).
 *
 * Pure: it decides from data the caller already loaded, so it is trivially
 * unit-testable and can be re-run against a *proposed* shift state during an
 * edit preview without writing anything.
 */
export function validateAssignment(
  shift: ShiftForValidation,
  user: UserForValidation,
  ctx: ClaimContext,
  now: Date,
): AppError | null {
  if (shift.startsAt <= now) {
    return createAppError('SHIFT_IN_PAST', 'This shift has already started.')
  }

  const requirement = user.profession
    ? shift.requirements.find((r) => r.profession === user.profession)
    : undefined

  if (!user.profession || !requirement || requirement.requiredCount === 0) {
    const label = user.profession ? PROFESSION_LABELS[user.profession].toLowerCase() : 'that role'
    return createAppError('PROFESSION_NOT_REQUIRED',
      `This shift does not need a ${label}.`)
  }

  const filled = ctx.claimsByProfession[user.profession]
  if (filled >= requirement.requiredCount) {
    const label = PROFESSION_LABELS[user.profession].toLowerCase()
    return createAppError('ROLE_FULL',
      `This shift already has ${filled} of ${requirement.requiredCount} ${label}s.`,
      { profession: user.profession, filled, required: requirement.requiredCount })
  }

  const conflict = ctx.userOtherShifts.find((other) => overlaps(shift, other))
  if (conflict) {
    return createAppError('OVERLAP',
      `Overlaps a shift you already hold, ${timeLabel(conflict.startsAt)}–${timeLabel(conflict.endsAt)}.`,
      { conflictStartsAt: conflict.startsAt.toISOString() })
  }

  return null
}
