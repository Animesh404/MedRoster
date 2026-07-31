/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimButton } from '@/components/shift/claim-button'

// `ClaimButton` calls `useRouter()` (IMPORTANT-6: it refreshes on success,
// same as `AssignControl`/`EditDialog`/`DeleteDialog`) — outside a real
// Next.js app router tree, that throws "invariant expected app router to be
// mounted" the instant the component renders, so every test needs the stub.
// `vi.hoisted` is required here: `vi.mock` factories are hoisted above
// imports/top-level statements, so a plain `const refresh = vi.fn()` above
// it would be used before it's initialized.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  refresh.mockClear() // a plain `vi.fn()` (not `vi.spyOn`) isn't reset by `restoreAllMocks`
})

describe('ClaimButton', () => {
  it('shows the claimed state immediately, before the server responds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))) // never resolves
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))
    expect(screen.getByRole('button', { name: /release/i })).toBeInTheDocument()
  })

  it('rolls back and shows the server\'s own message on rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ROLE_FULL', message: 'This shift already has 3 of 3 nurses.' } }),
      { status: 409 },
    )))
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /claim/i })).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('This shift already has 3 of 3 nurses.')
    })
  })

  it('surfaces the overlap message verbatim rather than a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'OVERLAP', message: 'Overlaps a shift you already hold, 08:00–16:00 12 Aug.' } }),
      { status: 409 },
    )))
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Overlaps a shift you already hold')
    })
  })

  it('refreshes the server component tree on success (IMPORTANT-6)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    await waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    // The flip stays committed — this isn't a rollback path.
    expect(screen.getByRole('button', { name: /release/i })).toBeInTheDocument()
  })
})

/**
 * The half of the retry story that lives in the browser.
 *
 * Server-side idempotency (lib/rules/idempotency.ts) makes replaying a claim
 * safe — but nothing replays one unless the client does, and it must reuse the
 * SAME mutationId. A fresh key on retry is not a retry at all: the server sees
 * a genuinely new attempt, finds the claim already there, and answers
 * ALREADY_CLAIMED, which rolls the optimistic flip back and shows the nurse a
 * shift as unclaimed that they actually hold.
 */
describe('ClaimButton retrying a dropped request', () => {
  it('retries once with the SAME mutationId when the request never lands', async () => {
    const bodies: string[] = []
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      calls += 1
      bodies.push(String(init?.body ?? ''))
      // First attempt dies in transit — the exact case the server work exists
      // for. Second succeeds.
      return calls === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(new Response(JSON.stringify({ claimId: 1 }), { status: 200 }))
    }))

    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)
    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    await waitFor(() => expect(calls).toBe(2))
    const ids = bodies.map((b) => (JSON.parse(b) as { mutationId: string }).mutationId)
    expect(ids[0]).toBe(ids[1])
    // The optimistic flip stands — the retry succeeded, so no rollback.
    expect(screen.getByRole('button', { name: /release/i })).toBeInTheDocument()
  })

  it('surfaces a network failure instead of hanging on pending', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))

    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)
    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    // Rolled back to Claim, with a message — not stuck mid-flight forever.
    expect(await screen.findByRole('button', { name: /claim/i })).toBeEnabled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/connection|try again/i)
  })

  it('does not retry a request the server actually answered', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      return Promise.resolve(new Response(
        JSON.stringify({ error: { code: 'ROLE_FULL', message: 'That role is already full.' } }),
        { status: 409 },
      ))
    }))

    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)
    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already full/i)
    // A 409 is an answer, not a lost request. Retrying it would just ask the
    // same question twice.
    expect(calls).toBe(1)
  })
})
