import { describe, expect, it } from 'vitest'
import { applyEvent, newMutationId, shouldApply } from '@/hooks/use-realtime'

describe('newMutationId', () => {
  it('is long enough to be unique and satisfies the contract', () => {
    const id = newMutationId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(newMutationId()).not.toBe(id)
  })
})

describe('shouldApply', () => {
  it('drops the originator\'s own echo, which was already applied optimistically', () => {
    const mine = new Set(['abc12345'])
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: 'abc12345' }, mine)).toBe(false)
  })

  it('applies an event from another user', () => {
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: 'other999' }, new Set())).toBe(true)
  })

  it('applies an event with no mutation id', () => {
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: null }, new Set())).toBe(true)
  })
})

describe('applyEvent', () => {
  const week = {
    isoWeek: '2026-W33',
    staff: [{ id: 1, name: 'Ivy', profession: 'NURSE' as const }],
    shifts: [{
      id: 10, version: 0, startsAt: '2026-08-10T07:00:00.000Z', endsAt: '2026-08-10T15:00:00.000Z',
      requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 }, claimantIds: [],
    }],
  }

  it('adds a claimant on shift.claimed', () => {
    const next = applyEvent(week, {
      id: '1', type: 'shift.claimed', mutationId: null,
      payload: { shiftId: 10, userId: 2, name: 'Omar', profession: 'NURSE' },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([2])
    expect(next.staff.find((s) => s.id === 2)?.name).toBe('Omar')
  })

  it('removes a claimant on shift.unclaimed', () => {
    const seeded = { ...week, shifts: [{ ...week.shifts[0]!, claimantIds: [1] }] }
    const next = applyEvent(seeded, {
      id: '2', type: 'shift.unclaimed', mutationId: null, payload: { shiftId: 10, userId: 1 },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([])
  })

  it('removes every dropped claimant on shift.claims_dropped', () => {
    const seeded = { ...week, shifts: [{ ...week.shifts[0]!, claimantIds: [1, 2] }] }
    const next = applyEvent(seeded, {
      id: '3', type: 'shift.claims_dropped', mutationId: null,
      payload: { shiftId: 10, dropped: [{ userId: 1 }, { userId: 2 }] },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([])
  })

  it('drops the shift entirely on shift.deleted', () => {
    const next = applyEvent(week, {
      id: '4', type: 'shift.deleted', mutationId: null, payload: { shiftId: 10 },
    })
    expect(next.shifts).toHaveLength(0)
  })

  it('leaves the view untouched for an unknown event type', () => {
    expect(applyEvent(week, { id: '5', type: 'nonsense', mutationId: null, payload: {} })).toEqual(week)
  })
})
