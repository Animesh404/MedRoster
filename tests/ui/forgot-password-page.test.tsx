/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ForgotPasswordPage from '@/app/forgot-password/page'

const resetPasswordForEmail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({ auth: { resetPasswordForEmail } }),
}))

const CONFIRMATION = 'If that address is on the roster, a reset link is on its way.'

beforeEach(() => {
  resetPasswordForEmail.mockReset()
})

/**
 * The property that matters here is not "does the call succeed" — it's that
 * nothing about the rendered page tells the two cases apart. Asserting on
 * the visible confirmation text (rather than on which branch ran) is what
 * would actually catch a future "helpful" change that surfaces a rate-limit
 * or not-found error: this page must never look different for an address
 * that exists versus one that doesn't, or a network hiccup versus a clean
 * send.
 */
describe('ForgotPasswordPage anti-enumeration invariant', () => {
  it('shows the same confirmation for an address that exists', async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
    const user = userEvent.setup()
    render(<ForgotPasswordPage />)

    await user.type(screen.getByLabelText(/email/i), 'real@clinic.test')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument()
  })

  it('shows the identical confirmation for an address Supabase reports as not found', async () => {
    resetPasswordForEmail.mockResolvedValue({ data: null, error: { message: 'User not found' } })
    const user = userEvent.setup()
    render(<ForgotPasswordPage />)

    await user.type(screen.getByLabelText(/email/i), 'nobody@clinic.test')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument()
  })

  // A thrown rejection (e.g. a network failure) must not read any
  // differently than a clean send, or the presence/absence of the
  // confirmation itself becomes a signal. This also guards against the
  // button getting stuck on "Sending…" forever.
  it('shows the same confirmation even when the call rejects outright', async () => {
    resetPasswordForEmail.mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()
    render(<ForgotPasswordPage />)

    await user.type(screen.getByLabelText(/email/i), 'whoever@clinic.test')
    await user.click(screen.getByRole('button', { name: /send reset link/i }))

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send reset link/i })).not.toBeInTheDocument()
  })
})
