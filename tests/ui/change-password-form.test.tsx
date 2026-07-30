/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangePasswordForm } from '@/app/(app)/account/change-password-form'

const signInWithPassword = vi.hoisted(() => vi.fn())
const updateUser = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signInWithPassword, updateUser } }),
}))

beforeEach(() => {
  signInWithPassword.mockReset().mockResolvedValue({ error: null })
  updateUser.mockReset().mockResolvedValue({ error: null })
})

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  await user.type(screen.getByLabelText(/current password/i), current)
  await user.type(screen.getByLabelText(/^new password/i), next)
  await user.type(screen.getByLabelText(/confirm/i), next)
  await user.click(screen.getByRole('button', { name: /change password/i }))
}

describe('ChangePasswordForm', () => {
  // The requirement that is easy to miss: Supabase's updateUser does NOT ask
  // for the current password, so without this check an unattended signed-in
  // browser is enough to take over the account.
  it('verifies the current password before changing it', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" />)

    await fillAndSubmit(user, 'old-password', 'brand-new-password')

    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'ivy@c.test', password: 'old-password' })
    expect(updateUser).toHaveBeenCalledWith({ password: 'brand-new-password' })
  })

  // This is the single most important assertion in this file. The form has
  // no branch that skips verification — a member with no password yet sets
  // their first one through the recovery flow instead (see
  // app/(app)/account/page.tsx), never through this component — so this test
  // is the only thing standing between an unattended signed-in browser and a
  // full account takeover.
  it('does not change the password when the current one is wrong', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" />)

    await fillAndSubmit(user, 'wrong', 'brand-new-password')

    expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects a short new password before touching the network', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" />)

    await fillAndSubmit(user, 'old-password', 'short')

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i)
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('confirms success in place', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" />)

    await fillAndSubmit(user, 'old-password', 'brand-new-password')

    expect(await screen.findByRole('status')).toHaveTextContent(/password changed/i)
  })
})
