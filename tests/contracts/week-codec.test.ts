import { describe, expect, it } from 'vitest'
import { decodeWeek, encodeWeek, type WeekView } from '@/lib/contracts/week'
import { computeCoverage } from '@/lib/coverage'

const view: WeekView = {
  isoWeek: '2026-W33',
  staff: [
    { id: 12, name: 'Ivy Bell', profession: 'NURSE' },
    { id: 3, name: 'Omar Patel', profession: 'DOCTOR' },
  ],
  shifts: [
    {
      id: 501, version: 2,
      startsAt: '2026-08-12T07:00:00.000Z', endsAt: '2026-08-12T15:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 },
      claimantIds: [12, 3],
    },
  ],
}

describe('week codec', () => {
  it('round-trips a week view unchanged', () => {
    expect(decodeWeek(encodeWeek(view))).toEqual(view)
  })

  it('mentions each staff name exactly once no matter how many shifts they hold', () => {
    const busy: WeekView = {
      ...view,
      shifts: Array.from({ length: 20 }, (_, i) => ({ ...view.shifts[0]!, id: 600 + i })),
    }
    const json = JSON.stringify(encodeWeek(busy))
    expect(json.split('Ivy Bell').length - 1).toBe(1)
  })

  it('is materially smaller than the uncompressed view', () => {
    const busy: WeekView = {
      ...view,
      shifts: Array.from({ length: 35 }, (_, i) => ({ ...view.shifts[0]!, id: 600 + i })),
    }
    const compressed = JSON.stringify(encodeWeek(busy)).length
    const plain = JSON.stringify(busy).length
    expect(compressed).toBeLessThan(plain * 0.6)
  })
})

describe('computeCoverage', () => {
  const req = { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 }

  it('is EMPTY with nobody claimed', () => {
    const c = computeCoverage(req, { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
    expect(c.status).toBe('EMPTY')
    expect(c.missing).toEqual({ DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 })
  })

  it('is PARTIAL with some roles filled and names what is missing', () => {
    const c = computeCoverage(req, { DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 })
    expect(c.status).toBe('PARTIAL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 })
  })

  it('is FULL when every requirement is met', () => {
    const c = computeCoverage(req, { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 })
    expect(c.status).toBe('FULL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
  })

  it('never reports negative missing counts when over-staffed', () => {
    const c = computeCoverage(req, { DOCTOR: 2, NURSE: 5, RECEPTIONIST: 0 })
    expect(c.status).toBe('FULL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
  })
})
