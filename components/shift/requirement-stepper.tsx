'use client'

import type { Profession } from '@prisma/client'
import { Button } from '@/components/ui/button'
import { PROFESSION_LABELS } from '@/lib/domain/profession'

const MIN = 0
const MAX = 50

/**
 * One profession's headcount stepper — "how many nurses does this shift
 * need." Shared by the new-shift form and the edit dialog so the two can
 * never present a different max/step behaviour for the same
 * `requirementsSchema` bound (§lib/contracts/common.ts).
 */
export function RequirementStepper({
  profession,
  value,
  onChange,
}: {
  profession: Profession
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-card border border-border bg-card px-3 py-2">
      <span className="text-sm font-medium text-foreground">{PROFESSION_LABELS[profession]}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={value <= MIN}
          onClick={() => onChange(Math.max(MIN, value - 1))}
          aria-label={`Fewer ${PROFESSION_LABELS[profession].toLowerCase()}s required`}
        >
          −
        </Button>
        <span className="tabular w-6 text-center text-sm font-semibold" aria-live="polite">
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          disabled={value >= MAX}
          onClick={() => onChange(Math.min(MAX, value + 1))}
          aria-label={`More ${PROFESSION_LABELS[profession].toLowerCase()}s required`}
        >
          +
        </Button>
      </div>
    </div>
  )
}
