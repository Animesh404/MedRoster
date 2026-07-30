/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MembersTable } from '@/app/(app)/members/members-table'

const MEMBERS = [
  { id: 1, name: 'Dana Okonkwo', email: 'dana@c.test', role: 'MANAGER' as const, profession: null, status: 'active' as const },
  { id: 2, name: 'Ivy Bell', email: 'ivy@c.test', role: 'STAFF' as const, profession: 'NURSE' as const, status: 'invited' as const },
  { id: 3, name: 'Imported Person', email: 'imp@c.test', role: 'STAFF' as const, profession: 'DOCTOR' as const, status: 'no-account' as const },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))))
})

describe('MembersTable', () => {
  it('shows every member with their status', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    expect(screen.getByText('Dana Okonkwo')).toBeInTheDocument()
    expect(screen.getByText('Imported Person')).toBeInTheDocument()
    expect(screen.getByText(/no account/i)).toBeInTheDocument()
  })

  // The population the invite feature exists for — 31 of them at seed time.
  it('offers to invite somebody who has no account yet', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const row = screen.getByText('Imported Person').closest('tr')!
    expect(within(row).getByRole('button', { name: /invite/i })).toBeInTheDocument()
  })

  it('offers resend and revoke for a pending invite, not for an active member', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const pending = screen.getByText('Ivy Bell').closest('tr')!
    expect(within(pending).getByRole('button', { name: /resend/i })).toBeInTheDocument()
    expect(within(pending).getByRole('button', { name: /revoke/i })).toBeInTheDocument()

    const active = screen.getByText('Dana Okonkwo').closest('tr')!
    expect(within(active).queryByRole('button', { name: /resend/i })).toBeNull()
  })

  // Locking yourself out of the only page that could undo it.
  it('does not offer to deactivate yourself', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const self = screen.getByText('Dana Okonkwo').closest('tr')!
    expect(within(self).queryByRole('button', { name: /deactivate/i })).toBeNull()
  })

  it('posts the invite form to the API', async () => {
    const user = userEvent.setup()
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)

    await user.type(screen.getByLabelText(/email/i), 'fresh@c.test')
    await user.type(screen.getByLabelText(/name/i), 'Fresh Face')
    await user.click(screen.getByRole('button', { name: /send invite/i }))

    expect(fetch).toHaveBeenCalledWith('/api/members', expect.objectContaining({ method: 'POST' }))
  })

  it('surfaces a server error inline rather than silently failing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'ALREADY_CLAIMED', message: 'That person already has an account.' } }),
      { status: 409 },
    ))))
    const user = userEvent.setup()
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)

    await user.type(screen.getByLabelText(/email/i), 'dupe@c.test')
    await user.type(screen.getByLabelText(/name/i), 'Dupe')
    await user.click(screen.getByRole('button', { name: /send invite/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an account/i)
  })
})
