/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RadialGauge } from '@/components/radial-gauge'

describe('RadialGauge', () => {
  it('renders inline SVG, not a chart library', () => {
    const { container } = render(<RadialGauge value={0.47} label="47% staffed" />)
    expect(container.querySelector('svg')).toBeInTheDocument()
    expect(container.querySelectorAll('circle')).toHaveLength(2) // track + progress arc
  })

  it('exposes the label for assistive technology and prints the rounded percentage', () => {
    render(<RadialGauge value={0.47} label="47% staffed" />)
    expect(screen.getByRole('img', { name: '47% staffed' })).toBeInTheDocument()
    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('clamps out-of-range values instead of drawing an invalid arc', () => {
    render(<RadialGauge value={1.5} label="over" />)
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('clamps negative values to zero', () => {
    render(<RadialGauge value={-0.2} label="under" />)
    expect(screen.getByText('0%')).toBeInTheDocument()
  })
})
