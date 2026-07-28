/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShiftCard } from '@/components/week-grid/shift-card'
import { WeekGrid } from '@/components/week-grid/week-grid'
import type { WeekView } from '@/lib/contracts/week'

const view: WeekView = {
  isoWeek: '2026-W33',
  staff: [{ id: 1, name: 'Ivy Bell', profession: 'NURSE' }],
  shifts: [
    {
      id: 1,
      version: 0,
      startsAt: '2026-08-10T07:00:00.000Z',
      endsAt: '2026-08-10T15:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
      claimantIds: [1],
    },
    {
      id: 2,
      version: 0,
      startsAt: '2026-08-11T07:00:00.000Z',
      endsAt: '2026-08-11T15:00:00.000Z',
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
      claimantIds: [],
    },
  ],
}

describe('ShiftCard', () => {
  it('names exactly which roles are still missing', () => {
    render(<ShiftCard shift={view.shifts[0]!} claims={{ DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }} />)
    expect(screen.getByText(/1 nurse/i)).toBeInTheDocument()
    expect(screen.getByText(/1 doctor/i)).toBeInTheDocument()
  })

  it('says nothing is missing when fully staffed', () => {
    render(<ShiftCard shift={view.shifts[0]!} claims={{ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }} />)
    // Both the status dot's label and the missing-roles line read "Fully staffed" when there's nothing left to fill.
    expect(screen.getAllByText(/fully staffed/i).length).toBeGreaterThanOrEqual(2)
  })

  it('labels status in text as well as colour', () => {
    render(<ShiftCard shift={view.shifts[1]!} claims={{ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }} />)
    expect(screen.getByText(/nobody assigned/i)).toBeInTheDocument()
  })

  it('renders the time range in a monospace, tabular-figure element', () => {
    render(<ShiftCard shift={view.shifts[0]!} claims={{ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }} />)
    // 07:00–15:00 UTC on 10 Aug 2026 is 08:00–16:00 in clinic-local time (BST, UTC+1).
    const time = screen.getByText(/08:00–16:00/)
    expect(time.className).toContain('tabular')
  })
})

describe('WeekGrid', () => {
  it('renders all seven days even when some have no shifts', () => {
    render(<WeekGrid week={view} />)
    expect(screen.getAllByRole('group', { name: /day column/i })).toHaveLength(7)
  })

  it('places each shift under its own day', () => {
    render(<WeekGrid week={view} />)
    const monday = screen.getByRole('group', { name: /day column, monday/i })
    expect(within(monday).getAllByRole('article')).toHaveLength(1)
  })

  it('gives a day with no shifts a placeholder rather than an empty column', () => {
    render(<WeekGrid week={view} />)
    const wednesday = screen.getByRole('group', { name: /day column, wednesday/i })
    expect(within(wednesday).getByText(/no shifts scheduled/i)).toBeInTheDocument()
    expect(within(wednesday).queryAllByRole('article')).toHaveLength(0)
  })
})
