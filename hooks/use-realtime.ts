'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import type { OutboxEvent } from '@/lib/contracts/events'

export function newMutationId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * An event the caller originated has already been applied optimistically, so
 * replaying it would flicker. Everyone else's events apply normally (§7.1).
 *
 * This is deliberately just the predicate — WHERE the "ownMutationIds" set
 * lives is a caller concern. A single `useRealtimeWeek` instance only ever
 * watches one topic, so a caller that keeps one such set per hook instance
 * (rather than one shared across every topic a tab has ever visited) already
 * gets the right behaviour for the cross-topic case called out in the brief:
 * a `shift.edited` that crosses a week boundary shares one mutationId across
 * both topics' broadcasts, so dedup must key on (topic, mutationId), never
 * mutationId alone (see `components/realtime/week-realtime-sync.tsx`).
 */
export function shouldApply(event: OutboxEvent, ownMutationIds: Set<string>): boolean {
  return !event.mutationId || !ownMutationIds.has(event.mutationId)
}

/** True when realtime isn't configured at all — the app must still work
 *  fully by polling, since local Docker Postgres has no `realtime` schema. */
const HAS_SUPABASE = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)

// `createClient` throws synchronously — at MODULE LOAD, not just when a
// channel is opened — the instant its url argument is an empty string, so
// this can only be called at all when one is actually configured. Every
// call site below is already gated on `HAS_SUPABASE`, which is exactly the
// condition under which `supabase` is non-null here.
const supabase = HAS_SUPABASE
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '')
  : null

/** How often a polling client re-checks `/api/events/since` when Supabase
 *  Realtime isn't configured. Short enough to feel live in a demo, long
 *  enough not to hammer the API. */
const POLL_INTERVAL_MS = 4_000

export function useRealtimeWeek(
  isoWeek: string,
  handlers: { onEvent: (e: OutboxEvent) => void; onResync: () => void },
): { connected: boolean } {
  // Polling has no "subscribed" handshake to wait for, so it's connected
  // from the start; the Supabase path flips this once `.subscribe` reports
  // SUBSCRIBED. Computed once as the initial value (not via a `setConnected`
  // called synchronously from inside the effect below) so the polling
  // branch never needs its own separate state-setting statement.
  const [connected, setConnected] = useState(() => !HAS_SUPABASE)
  const lastIdRef = useRef('0')
  const handlersRef = useRef(handlers)

  // Refs must not be written during render (only read, or written in an
  // effect/event handler) — updating this one every render, in an effect
  // with no dependency array, keeps `catchUp`'s closure over `handlers`
  // fresh without a stale-closure bug, without touching it mid-render.
  useEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    const topic = `week:${isoWeek}`
    let cancelled = false

    // `EventOutbox.id` is one global sequence across every topic, so a
    // cursor left over from whichever topic this hook instance was
    // subscribed to before (a prop change on an already-mounted instance —
    // e.g. `/shifts/[id]` navigating to a shift in a different week) would
    // make the NEW topic's own early events look "already seen" and skip
    // them (MINOR-9). Starting every fresh effect run — mount or topic
    // switch alike — at '0' means the very first `catchUp` below always
    // sees the topic's full history, never a stale high-water mark.
    lastIdRef.current = '0'

    // That "full history" first catch-up is itself the other bug (IMPORTANT-2):
    // a topic that has been live for a while can hold dozens of events, and
    // dispatching every one of them to `onEvent` the instant this component
    // mounts turns into a `router.refresh()` storm with zero real activity
    // (measured: 46 events -> 46 refreshes). The first catch-up's only job is
    // to learn where "now" is; there is no client-held view to reconcile yet,
    // so nothing from it should reach `onEvent`/`onResync`. Every catch-up
    // after that — the next poll tick, a reconnect, a tab regaining focus —
    // dispatches normally.
    let firstCatchUp = true

    /** Fetches everything missed since lastId — broadcast has no history (§7.1). */
    async function catchUp() {
      const res = await fetch(
        `/api/events/since?topic=${encodeURIComponent(topic)}&id=${lastIdRef.current}`)
      if (!res.ok || cancelled) return
      const body = await res.json() as { events: OutboxEvent[]; lastId: string; truncated: boolean }
      const isSeeding = firstCatchUp
      firstCatchUp = false

      if (body.truncated) {
        // Too far behind to reconcile event-by-event; refetch rather than diverge.
        lastIdRef.current = body.lastId
        if (!isSeeding) handlersRef.current.onResync()
        return
      }
      if (!isSeeding) {
        for (const event of body.events) handlersRef.current.onEvent(event)
      }
      lastIdRef.current = body.lastId
    }

    if (!HAS_SUPABASE) {
      // Degrade to polling replay — same `catchUp` the connected path uses
      // for reconnect/tab-focus, just on a timer instead of a broadcast.
      void catchUp()
      const pollTimer = setInterval(() => void catchUp(), POLL_INTERVAL_MS)
      return () => {
        cancelled = true
        clearInterval(pollTimer)
      }
    }

    // non-null: reaching here means HAS_SUPABASE was true above
    const channel: RealtimeChannel = supabase!
      .channel(topic, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: '*' }, ({ payload }) => {
        const event = payload as OutboxEvent
        if (Number(event.id) <= Number(lastIdRef.current)) return // already seen
        lastIdRef.current = event.id
        handlersRef.current.onEvent(event)
      })
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') void catchUp()
      })

    // A tab woken from sleep may have missed everything; reconcile on focus.
    const onVisible = () => { if (document.visibilityState === 'visible') void catchUp() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void supabase!.removeChannel(channel)
    }
  }, [isoWeek])

  return { connected }
}
