/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '@/lib/auth/permissions'

// AppShell renders <UserMenu>, which calls a Server Action that transitively
// imports the real Auth.js config (next-auth -> next/server). That module
// graph assumes the Next.js runtime and doesn't resolve under plain
// Vitest/jsdom, so it's stubbed here — this test only cares about nav
// filtering, not sign-out wiring.
vi.mock('@/app/(app)/actions', () => ({
  signOutAction: vi.fn(),
}))

const { AppShell } = await import('@/components/app-shell')

const MANAGER: Principal = { id: 1, role: 'MANAGER', profession: null }
const STAFF: Principal = { id: 2, role: 'STAFF', profession: 'NURSE' }

describe('AppShell nav', () => {
  it('never shows a staff member the manager-only controls', () => {
    render(
      <AppShell principal={STAFF} name="Ivy Bell" email="ivy.bell@clinicmail.test">
        <p>content</p>
      </AppShell>,
    )
    expect(screen.queryByRole('link', { name: 'New shift' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Dashboard' }).length).toBeGreaterThan(0)
  })

  it('shows a manager every nav item, including the ones staff never see', () => {
    render(
      <AppShell principal={MANAGER} name="Dana Okonkwo" email="manager@clinicmail.test">
        <p>content</p>
      </AppShell>,
    )
    expect(screen.getAllByRole('link', { name: 'New shift' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: 'Import' }).length).toBeGreaterThan(0)
  })
})
