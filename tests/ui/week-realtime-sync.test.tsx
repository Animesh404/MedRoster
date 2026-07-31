/** @vitest-environment jsdom */
import { useEffect } from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeekRealtimeSync, useRegisterMutation } from '@/components/realtime/week-realtime-sync'

// `WeekRealtimeSync` calls `useRouter()` from a plain jsdom render (no real
// Next.js app router tree), which otherwise throws "invariant expected app
// router to be mounted". `useRouter` returns a FRESH stub object per call —
// tests below tell instances apart by which stub's `refresh` fired, the same
// way two different pages/components each get their own router in the app.
const routers: { refresh: ReturnType<typeof vi.fn> }[] = []
vi.mock('next/navigation', () => ({
  useRouter: () => {
    const router = { refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }
    routers.push(router)
    return router
  },
}))

/** Response shape `/api/events/since` returns. */
function eventsSinceBody(events: unknown[], lastId: string) {
  return { events, lastId, truncated: false }
}

/** Reads `topic=` off the fetch URL so a mock can answer per-topic. */
function topicOf(url: string): string {
  return new URL(url, 'http://localhost').searchParams.get('topic') ?? ''
}

/** Flushes the promise chain (fetch -> res.json() -> handler dispatch)
 *  without actually advancing fake timers — `vi.advanceTimersByTimeAsync(0)`
 *  processes the pending microtask queue on every tick it takes, which is
 *  exactly what's needed here and, unlike `@testing-library`'s `waitFor`,
 *  never itself waits on a real timer that fake timers freeze forever. */
async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  vi.useFakeTimers()
  routers.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WeekRealtimeSync — fresh mount with existing history (IMPORTANT-2)', () => {
  it('produces zero refreshes for a topic that already holds history, then still reacts to a genuinely new event', async () => {
    // A realistic backlog — the seeded `week:2026-W32` topic held 46 events
    // when this bug was found; 5 stands in for "more than zero," which is
    // all the assertion below needs.
    const backlog = Array.from({ length: 5 }, (_, i) => ({
      id: String(i + 1), type: 'shift.claimed', mutationId: null, payload: {},
    }))
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response(JSON.stringify(eventsSinceBody(backlog, '5')))
      if (call === 2) return new Response(JSON.stringify(eventsSinceBody([], '5')))
      return new Response(JSON.stringify(eventsSinceBody(
        [{ id: '6', type: 'shift.claimed', mutationId: null, payload: {} }], '6',
      )))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WeekRealtimeSync isoWeek="2026-W32">{null}</WeekRealtimeSync>)

    // First (seeding) catch-up: fetches the full backlog but must not
    // dispatch any of it — this is the exact bug (46 events -> 46 refreshes).
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(routers[0]!.refresh).not.toHaveBeenCalled()

    // A poll tick with no new activity: still zero refreshes.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(routers[0]!.refresh).not.toHaveBeenCalled()

    // A poll tick that DOES carry a genuinely new event: the mechanism
    // still works — this isn't "never refreshes," only "not on stale history."
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(routers[0]!.refresh).toHaveBeenCalledTimes(1)
  })
})

function Registrar({ mutationId }: { mutationId: string }) {
  const registerMutation = useRegisterMutation()
  useEffect(() => { registerMutation(mutationId) }, [registerMutation, mutationId])
  return null
}

describe('WeekRealtimeSync — cross-topic mutationId dedup (IMPORTANT-4)', () => {
  it('lets each topic apply a shift.edited that shares one mutationId, rather than one instance suppressing the other', async () => {
    const SHARED_MUTATION_ID = 'shared0001editxx'
    const editedEvent = (id: string) => ({
      id, type: 'shift.edited', mutationId: SHARED_MUTATION_ID,
      payload: { shiftId: 42, startsAt: '2026-08-10T09:00:00.000Z', endsAt: '2026-08-10T17:00:00.000Z' },
    })

    const callsByTopic = new Map<string, number>()
    const fetchMock = vi.fn(async (url: string) => {
      const topic = topicOf(url)
      const call = (callsByTopic.get(topic) ?? 0) + 1
      callsByTopic.set(topic, call)

      if (call === 1) return new Response(JSON.stringify(eventsSinceBody([], '0'))) // seeding catch-up
      // Second catch-up: BOTH topics' broadcasts carry the SAME mutationId —
      // exactly what a `shift.edited` crossing a week boundary does
      // (lib/rules/edit.ts emits it once per affected topic, one mutationId
      // to spend per commit).
      return new Response(JSON.stringify(eventsSinceBody([editedEvent('2')], '2')))
    })
    vi.stubGlobal('fetch', fetchMock)

    // Instance A (week:2026-W10) is where the edit's own mutation was
    // registered — the topic the page doing the editing was subscribed to.
    // Instance B (week:2026-W11) represents anything else in the app
    // subscribed to the OTHER affected topic, with no idea about A's mutation.
    render(
      <>
        <WeekRealtimeSync isoWeek="2026-W10">
          <Registrar mutationId={SHARED_MUTATION_ID} />
        </WeekRealtimeSync>
        <WeekRealtimeSync isoWeek="2026-W11">{null}</WeekRealtimeSync>
      </>,
    )

    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2) // both topics' seeding catch-up

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(fetchMock).toHaveBeenCalledTimes(4) // both topics' second poll

    // A registered the mutationId: this is its own already-applied echo.
    expect(routers[0]!.refresh).not.toHaveBeenCalled()
    // B never registered it — a shared/module-level set would have wrongly
    // suppressed this too (MINOR the brief calls out); scoped per instance,
    // B correctly treats it as a real change and refreshes.
    expect(routers[1]!.refresh).toHaveBeenCalledTimes(1)
  })
})

/**
 * What makes pruning `EventOutbox` safe.
 *
 * Once old events are deleted, a client whose cursor points below them asks for
 * `id > lastId` and gets nothing back — indistinguishable from "no activity".
 * `cursorLost` is the server saying "what you asked for is gone"; the client
 * must refetch rather than carry on believing it is current.
 */
describe('WeekRealtimeSync — a cursor whose events have been pruned', () => {
  it('refetches rather than assuming it is up to date', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      // Seed normally, so the component is past its first catch-up.
      if (call === 1) return new Response(JSON.stringify(eventsSinceBody([], '10')))
      // Then the server reports the cursor has fallen off the end. Note the
      // event list is EMPTY — which pre-`cursorLost` was read as "nothing has
      // happened", the silent-staleness bug this exists to prevent.
      return new Response(JSON.stringify({
        events: [], lastId: '900', truncated: false, cursorLost: true,
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WeekRealtimeSync isoWeek="2026-W32">{null}</WeekRealtimeSync>)
    await flush()
    expect(routers[0]!.refresh).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(routers[0]!.refresh).toHaveBeenCalledTimes(1)
  })

  it('adopts the server cursor, so it does not report lost forever', async () => {
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      call += 1
      // Call 1 is the seed. From call 2 on, the answer depends purely on the
      // cursor the client sends: below the watermark it is lost, at or above
      // it the client is current again.
      if (call === 1) return new Response(JSON.stringify(eventsSinceBody([], '0')))
      const id = Number(new URL(String(url), 'http://localhost').searchParams.get('id'))
      if (id < 900) {
        return new Response(JSON.stringify({ events: [], lastId: '900', truncated: false, cursorLost: true }))
      }
      return new Response(JSON.stringify(eventsSinceBody([], '900')))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WeekRealtimeSync isoWeek="2026-W32">{null}</WeekRealtimeSync>)
    await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    const afterFirstLoss = routers[0]!.refresh.mock.calls.length

    // Two more quiet polls: now caught up, so no further refreshes.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(afterFirstLoss).toBe(1)
    expect(routers[0]!.refresh).toHaveBeenCalledTimes(1)
  })

  // A resync on every mount would be a pointless refetch: the page has just
  // rendered fresh server state.
  it('does not refetch when the cursor is lost on the very first catch-up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      events: [], lastId: '900', truncated: false, cursorLost: true,
    }))))

    render(<WeekRealtimeSync isoWeek="2026-W32">{null}</WeekRealtimeSync>)
    await flush()

    expect(routers[0]!.refresh).not.toHaveBeenCalled()
  })
})
