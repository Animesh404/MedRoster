/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SlotMeter } from '@/components/slot-meter'
import { buildMeter, meterLabel } from '@/lib/ui/tokens'

describe('SlotMeter', () => {
  it('renders one .slot element per required slot, filled and hollow distinguished by class', () => {
    const segments = buildMeter({ DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 }, { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 })
    const { container } = render(<SlotMeter segments={segments} />)

    const slots = container.querySelectorAll('.slot')
    expect(slots).toHaveLength(4) // 3 nurse rails + 1 doctor rail

    const filled = container.querySelectorAll('.slot--filled')
    const empty = container.querySelectorAll('.slot--empty')
    expect(filled).toHaveLength(3) // 2 nurses + 1 doctor held
    expect(empty).toHaveLength(1) // 1 nurse gap
  })

  it('exposes the plain-text meter label for assistive technology', () => {
    const segments = buildMeter({ DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 }, { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 })
    render(<SlotMeter segments={segments} />)
    expect(screen.getByRole('img', { name: meterLabel(segments) })).toBeInTheDocument()
  })

  it('renders no slots and says so when a shift needs nobody', () => {
    const { container } = render(<SlotMeter segments={[]} />)
    expect(container.querySelectorAll('.slot')).toHaveLength(0)
    expect(screen.getByText('No staffing required')).toBeInTheDocument()
  })
})
