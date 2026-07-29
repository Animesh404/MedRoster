/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimButton } from '@/components/shift/claim-button'

afterEach(() => { vi.restoreAllMocks() })

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
})
