/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetPasswordForm } from '@/app/auth/set-password-form'

const updateUser = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({ auth: { updateUser } }),
}))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

beforeEach(() => {
  updateUser.mockReset().mockResolvedValue({ error: null })
  push.mockReset()
})

describe('SetPasswordForm', () => {
  it('rejects a password shorter than 8 characters without calling Supabase', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'short')
    await user.type(screen.getByLabelText(/confirm/i), 'short')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects a mismatched confirmation without calling Supabase', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-hose')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('sets the password and redirects on success', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-battery')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(updateUser).toHaveBeenCalledWith({ password: 'correct-horse-battery' })
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  // An expired or already-used link is the single most common real failure
  // here, and it must say so rather than showing a blank form that never works.
  it('surfaces a Supabase error instead of redirecting', async () => {
    updateUser.mockResolvedValue({ error: { message: 'Auth session missing!' } })
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-battery')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/link may have expired/i)
    expect(push).not.toHaveBeenCalled()
  })
})
