'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { newMutationId } from '@/hooks/use-realtime'
import { useRegisterMutation } from '@/components/realtime/week-realtime-sync'

/**
 * Manager-only removal of someone ELSE's claim — `claim:delete:any`, the
 * stronger sibling of the release button every staff member gets for their
 * own claim (`claim:delete:self`, see `ClaimButton`). Deliberately its own
 * tiny component rather than a mode of `ClaimButton`: this one is never
 * optimistic (a manager removing another person's shift is consequential
 * enough that a static confirm-by-result is more honest than an instant
 * flip a rare rejection would have to visibly reverse).
 */
export function RemoveClaimButton({ shiftId, userId, name }: { shiftId: number; userId: number; name: string }) {
  const router = useRouter()
  const registerMutation = useRegisterMutation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setPending(true)
    setError(null)
    const mutationId = newMutationId()
    registerMutation(mutationId)

    const res = await fetch(`/api/shifts/${shiftId}/claims/${userId}?mutationId=${mutationId}`, { method: 'DELETE' })
    setPending(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setError(body?.error?.message ?? 'Something went wrong. Please try again.')
      return
    }
    router.refresh()
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => void remove()}
        aria-label={`Remove ${name} from this shift`}
        className="rounded-full px-1.5 py-0.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        Remove
      </button>
      {error && <span role="alert" className="text-xs text-rose-700 dark:text-rose-400">{error}</span>}
    </span>
  )
}
