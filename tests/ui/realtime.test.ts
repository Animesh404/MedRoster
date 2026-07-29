import { describe, expect, it } from 'vitest'
import { newMutationId, shouldApply } from '@/hooks/use-realtime'

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
