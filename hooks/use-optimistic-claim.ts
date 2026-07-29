'use client'

import { useState } from 'react'
import { newMutationId } from '@/hooks/use-realtime'

export interface UseOptimisticClaimResult {
  /** Flips before the request lands; rolls back to the server-confirmed
   *  value on rejection. This is what the button renders. */
  claimed: boolean
  pending: boolean
  /** The server's OWN rejection message — never a client-side guess. */
  error: string | null
  claim: () => void
  release: () => void
}

/**
 * Optimistic claim/release (§8.3). The state flips before the request lands
 * and rolls back on rejection, surfacing the SERVER's message — the exact
 * string `validateAssignment` produced. Showing it verbatim is what
 * demonstrates the rule is enforced server-side rather than guessed at here.
 *
 * `onMutationStart` is how a caller wires this into realtime echo
 * suppression: `components/realtime/week-realtime-sync.tsx` passes its
 * `registerMutation`, so the mutationId this hook mints is already known to
 * the topic's own-echo set by the time the broadcast could possibly arrive.
 */
export function useOptimisticClaim(
  shiftId: number,
  params: {
    claimed: boolean
    userId: number
    onMutationStart?: (mutationId: string) => void
    /** Called once the request succeeds — lets a caller re-fetch the server
     *  component tree (`AssignControl`/`EditDialog`/`DeleteDialog` all do the
     *  same on their own success paths). Without it, a released shift stays
     *  in a stale list (e.g. `/my-shifts`) until a manual reload, and a
     *  claim/release racing the realtime poll only settles once that poll
     *  happens to land. */
    onSuccess?: () => void
  },
): UseOptimisticClaimResult {
  const [optimistic, setOptimistic] = useState(params.claimed)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Deliberately plain state, not `useTransition`: a transition's updates
  // are low-priority and React is free to keep rendering the OLD state
  // until every update inside the transition (including ones scheduled
  // after an `await`) is ready — which would hold the "flip immediately"
  // behaviour hostage to the fetch resolving, defeating the entire point of
  // an optimistic update. Plain `setState` commits the pre-await flip on
  // its own turn regardless of how long the request takes.
  async function toggle(next: boolean) {
    const previous = optimistic
    setOptimistic(next)   // flip first
    setError(null)
    setPending(true)

    const mutationId = newMutationId()
    params.onMutationStart?.(mutationId)

    const res = next
      ? await fetch(`/api/shifts/${shiftId}/claims`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutationId }),
        })
      : await fetch(`/api/shifts/${shiftId}/claims/${params.userId}?mutationId=${mutationId}`, {
          method: 'DELETE',
        })

    setPending(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setOptimistic(previous)   // roll back
      setError(body?.error?.message ?? 'Something went wrong. Please try again.')
      return
    }
    params.onSuccess?.()
  }

  return {
    claimed: optimistic,
    pending,
    error,
    claim: () => { void toggle(true) },
    release: () => { void toggle(false) },
  }
}
