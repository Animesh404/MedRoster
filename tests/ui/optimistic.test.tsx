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
