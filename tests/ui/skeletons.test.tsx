/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShiftCardSkeleton, WeekGridSkeleton, ImportReportSkeleton } from '@/components/skeletons'

describe('skeletons', () => {
  it('renders one column per weekday so the grid does not reflow on load', () => {
    const { container } = render(<WeekGridSkeleton />)
    expect(container.querySelectorAll('[data-skeleton-day]')).toHaveLength(7)
  })

  it('marks a shift-card skeleton busy for assistive technology', () => {
    render(<ShiftCardSkeleton />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })

  it('marks the import-report skeleton busy for assistive technology', () => {
    render(<ImportReportSkeleton />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })
})
