'use client'

import { createContext, startTransition, useCallback, useContext, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useRealtimeWeek, shouldApply } from '@/hooks/use-realtime'

/** How long a mutationId is remembered as "mine" before it's evicted — long
 *  enough to outlast any realistic broadcast/replay delay, short enough that
 *  the set never grows unbounded across a long session. */
const MUTATION_TTL_MS = 60_000

const RegisterMutationContext = createContext<(mutationId: string) => void>(() => {})

/** Lets a claim button / edit dialog register the mutationId it just minted,
 *  so the enclosing `<WeekRealtimeSync>` can drop that mutation's own echo
 *  instead of re-rendering the page out from under an already-applied
 *  optimistic update. Safe to call with no provider mounted (default no-op)
 *  — e.g. `ClaimButton`'s unit tests render it standalone. */
export function useRegisterMutation(): (mutationId: string) => void {
  return useContext(RegisterMutationContext)
}

/**
 * Subscribes to one week's realtime topic and turns every non-echo event
 * into a `router.refresh()` — the simplest correct reconciliation for a
 * server-rendered page: the mutation that produced the event has already
 * committed by the time it broadcasts, so re-fetching the server component
 * tree picks up the same state a client-side reducer would have converged
 * on, without this app needing a second, parallel client-side copy of
 * `WeekView` to keep in sync.
 *
 * One instance = one topic, which is what keeps echo suppression correct
 * across the cross-topic case §7.1 calls out: a `shift.edited` that moves a
 * shift across a week boundary shares one mutationId on both topics'
 * broadcasts, so a set shared across topics could wrongly suppress a
 * legitimate second-topic event as an echo of the first. Scoping the
 * "mine" set to this single hook instance (one topic) sidesteps that
 * entirely rather than trying to key a shared set on (topic, mutationId).
 *
 * There is no client-held `WeekView` here to patch event-by-event — this is
 * the ONLY reconciliation strategy in play, not a fallback alongside a
 * reducer. `shouldApply` remains the pure, directly-unit-tested predicate
 * (`tests/ui/realtime.test.ts`) that decides whether an event is this
 * instance's own already-applied echo; everything that clears it just
 * triggers the refresh above.
 */
export function WeekRealtimeSync({ isoWeek, children }: { isoWeek: string; children: ReactNode }) {
  const router = useRouter()
  const ownMutationIds = useRef(new Set<string>())

  const registerMutation = useCallback((mutationId: string) => {
    ownMutationIds.current.add(mutationId)
    setTimeout(() => ownMutationIds.current.delete(mutationId), MUTATION_TTL_MS)
  }, [])

  useRealtimeWeek(isoWeek, {
    // Wrapped in `startTransition`: this fires from a `setInterval` tick (the
    // polling fallback) or a broadcast callback, never from a React event
    // handler, so it needs to explicitly opt into React's transition
    // scheduling for `router.refresh()`'s update to be treated as a real
    // pending navigation rather than a stray effect.
    onEvent: (event) => {
      if (shouldApply(event, ownMutationIds.current)) startTransition(() => router.refresh())
    },
    // Too far behind to reconcile event-by-event — refetch rather than diverge (§7.1).
    onResync: () => startTransition(() => router.refresh()),
  })

  return (
    <RegisterMutationContext.Provider value={registerMutation}>
      {children}
    </RegisterMutationContext.Provider>
  )
}
