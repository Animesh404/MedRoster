/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AssignControl } from '@/components/shift/assign-control'

// `AssignControl` calls `useRouter()` on success — outside a real Next.js
// app router tree that throws, so every test needs the stub (see
// tests/ui/optimistic.test.tsx for the same pattern).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}))

describe('AssignControl', () => {
  it('shows the candidate\'s NAME after picking them, not the raw id it stores as the select value (regression)', async () => {
    // Base UI's <Select.Value> renders the raw `value` string of the
    // selected `<Select.Item>` by default — without passing `items` to
    // `<Select.Root>`, picking "Anya Haddad" (id 33) left the trigger
    // reading "33", a bug only visible by actually opening the dropdown in
    // a browser, which is exactly what a server-side/SSR-only sweep can't do.
    render(
      <AssignControl
        shiftId={1}
        profession="NURSE"
        candidates={[{ id: 33, name: 'Anya Haddad' }, { id: 18, name: 'Tara Rossi' }]}
      />,
    )

    await userEvent.click(screen.getByRole('combobox', { name: /assign a nurse/i }))

    // base-ui mounts the listbox in a portal after an animation frame, so the
    // option is not queryable the instant the trigger is clicked, and the
    // trigger's own label settles asynchronously after the selection commits.
    // Racing either of those made this test intermittently red.
    const option = await screen.findByRole('option', { name: 'Anya Haddad' })
    await userEvent.click(option)

    await waitFor(() => {
      const combo = screen.getByRole('combobox', { name: /assign a nurse/i })
      expect(combo).toHaveTextContent('Anya Haddad')
      expect(combo).not.toHaveTextContent('33')
    })
  })
})
