/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ImportUploadForm } from '@/components/import/import-upload-form'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}))

describe('ImportUploadForm', () => {
  it('shows the file-kind LABEL after picking it, not the raw enum value (regression)', async () => {
    // Same class of bug as AssignControl: base-ui's <Select.Value> renders
    // the raw stored value ("SHIFT") rather than its label ("Shift
    // schedule") unless `items` is passed to `<Select.Root>`.
    render(<ImportUploadForm />)

    await userEvent.click(screen.getByRole('combobox', { name: 'File kind' }))

    // base-ui mounts the listbox in a portal after an animation frame, so the
    // option is not queryable the instant the trigger is clicked. Clicking a
    // not-yet-mounted option is what made this intermittently red — wait for it
    // rather than racing it.
    const option = await screen.findByRole('option', { name: 'Shift schedule' })
    await userEvent.click(option)

    // Likewise the trigger's label updates asynchronously once the selection
    // commits, so assert on the settled state instead of the next tick.
    await waitFor(() => {
      const combo = screen.getByRole('combobox', { name: 'File kind' })
      expect(combo).toHaveTextContent('Shift schedule')
      expect(combo).not.toHaveTextContent('SHIFT')
    })
  })
})
