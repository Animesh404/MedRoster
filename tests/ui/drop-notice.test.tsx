/** @vitest-environment jsdom */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropNoticeBanner, type DropNotice } from '@/components/my-shifts/drop-notice'

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}))

const NOTICES: DropNotice[] = [
  {
    id: 11, shiftId: 1, reason: 'A manager edited this shift.', at: '2026-08-01T09:00:00Z',
    kind: 'dropped', shiftStartsAt: '2026-08-20T09:00:00Z', shiftEndsAt: '2026-08-20T17:00:00Z',
  },
  {
    id: 12, shiftId: 2, reason: 'A manager deleted this shift.', at: '2026-08-01T10:00:00Z',
    kind: 'deleted', shiftStartsAt: null, shiftEndsAt: null,
  },
]

beforeEach(() => {
  vi.restoreAllMocks()
  refresh.mockClear()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))))
})

describe('DropNoticeBanner', () => {
  it('renders one row per notice', () => {
    render(<DropNoticeBanner notices={NOTICES} />)
    expect(screen.getByText(/removed from 2 shifts/i)).toBeInTheDocument()
    expect(screen.getByText(/a manager edited this shift/i)).toBeInTheDocument()
  })

  // A deleted shift whose times were never recovered still has to render —
  // hiding it would be the silent loss this whole feature exists to prevent.
  it('still shows a notice whose shift time is unknown', () => {
    render(<DropNoticeBanner notices={[NOTICES[1]!]} />)
    expect(screen.getByText(/shift #2/i)).toBeInTheDocument()
  })

  it('dismisses against the notice id, not its position', async () => {
    const user = userEvent.setup()
    render(<DropNoticeBanner notices={NOTICES} />)

    const row = screen.getByText(/a manager deleted this shift/i).closest('li')!
    await user.click(within(row).getByRole('button', { name: /dismiss/i }))

    expect(fetch).toHaveBeenCalledWith('/api/notices/12', expect.objectContaining({ method: 'DELETE' }))
  })

  it('removes the dismissed notice immediately, without waiting for the server', async () => {
    // Never resolves — so anything that appears did so optimistically.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const user = userEvent.setup()
    render(<DropNoticeBanner notices={NOTICES} />)

    const row = screen.getByText(/a manager edited this shift/i).closest('li')!
    await user.click(within(row).getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText(/a manager edited this shift/i)).toBeNull()
    // The other one stays: dismissing is per-notice, not all-or-nothing.
    expect(screen.getByText(/a manager deleted this shift/i)).toBeInTheDocument()
    expect(screen.getByText(/removed from a shift/i)).toBeInTheDocument()
  })

  it('disappears entirely once every notice is dismissed', async () => {
    const user = userEvent.setup()
    render(<DropNoticeBanner notices={NOTICES} />)

    for (const name of [/a manager edited this shift/i, /a manager deleted this shift/i]) {
      const row = screen.getByText(name).closest('li')!
      await user.click(within(row).getByRole('button', { name: /dismiss/i }))
    }

    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The optimistic hide is a guess. Refreshing is what reconciles it with the
  // server, so a refused dismissal comes back rather than staying hidden.
  it('refreshes so a refused dismissal reappears', async () => {
    const user = userEvent.setup()
    render(<DropNoticeBanner notices={NOTICES} />)

    const row = screen.getByText(/a manager edited this shift/i).closest('li')!
    await user.click(within(row).getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('does not leave an unhandled rejection when the request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    const user = userEvent.setup()
    render(<DropNoticeBanner notices={NOTICES} />)

    const row = screen.getByText(/a manager edited this shift/i).closest('li')!
    await user.click(within(row).getByRole('button', { name: /dismiss/i }))

    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('renders nothing when there are no notices', () => {
    const { container } = render(<DropNoticeBanner notices={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
