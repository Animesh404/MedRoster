/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

// Regression coverage for a browser-only bug a server-side/SSR-only sweep
// can never see: `DropdownMenuContent`'s popup (and everything inside it,
// including `DropdownMenuItem`'s click handler) only mounts once a real user
// opens the menu. Every earlier test of this component (see
// tests/ui/app-shell.test.tsx) rendered `UserMenu` without ever opening it,
// so neither bug below was ever exercised until a real click did.
const { signOutAction } = vi.hoisted(() => ({ signOutAction: vi.fn() }))
vi.mock('@/app/(app)/actions', () => ({ signOutAction }))

const { UserMenu } = await import('@/components/user-menu')

describe('UserMenu', () => {
  it('opens without throwing (regression: Menu.GroupLabel needs a Menu.Group ancestor)', async () => {
    // Base UI's `Menu.GroupLabel` — what `DropdownMenuLabel` renders — throws
    // "MenuGroupContext is missing" if it isn't wrapped in a `<Menu.Group>`.
    // That only happens once the popup actually mounts (a real click), which
    // crashed the whole menu in the browser and made "Sign out" unreachable
    // even though the trigger button itself rendered fine.
    render(<UserMenu name="Dana Okonkwo" email="manager@clinicmail.test" roleLabel="Manager" />)

    await userEvent.click(screen.getByRole('button', { name: /Dana Okonkwo/ }))

    expect(await screen.findByText('manager@clinicmail.test')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Sign out/ })).toBeInTheDocument()
  })

  it('actually calls signOutAction when "Sign out" is clicked (regression: onSelect never fires on Menu.Item)', async () => {
    // Base UI's `Menu.Item` only recognises `onClick` — there is no
    // Radix-style `onSelect` callback. `onSelect` type-checked anyway
    // (React's `DOMAttributes<div>` declares a native, input/textarea-only
    // `onSelect` event for every element), so `tsc` never caught that it
    // silently never fired.
    render(<UserMenu name="Dana Okonkwo" email="manager@clinicmail.test" roleLabel="Manager" />)

    await userEvent.click(screen.getByRole('button', { name: /Dana Okonkwo/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Sign out/ }))

    await waitFor(() => { expect(signOutAction).toHaveBeenCalledTimes(1) })
  })
})
