import { describe, expect, it } from 'vitest'
import { validateAssignment } from '@/lib/rules/validate'

const NOW = new Date('2026-08-01T00:00:00Z')

const shift = (over: Partial<Parameters<typeof validateAssignment>[0]> = {}) => ({
  id: 1,
  startsAt: new Date('2026-08-12T07:00:00Z'),
  endsAt: new Date('2026-08-12T15:00:00Z'),
  requirements: [
    { profession: 'NURSE' as const, requiredCount: 2 },
    { profession: 'DOCTOR' as const, requiredCount: 1 },
    { profession: 'RECEPTIONIST' as const, requiredCount: 0 },
  ],
  ...over,
})

const nurse = { id: 7, profession: 'NURSE' as const }
const ctx = (over = {}) => ({
  claimsByProfession: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 0 },
  userOtherShifts: [],
  ...over,
})

describe('validateAssignment', () => {
  it('accepts a nurse when a nurse slot is free', () => {
    expect(validateAssignment(shift(), nurse, ctx(), NOW)).toBeNull()
  })

  it('rejects a claim on a shift that has already started', () => {
    const err = validateAssignment(shift(), nurse, ctx(), new Date('2026-08-12T08:00:00Z'))
    expect(err!.code).toBe('SHIFT_IN_PAST')
  })

  it('rejects a profession the shift does not need', () => {
    const err = validateAssignment(shift(), { id: 9, profession: 'RECEPTIONIST' }, ctx(), NOW)
    expect(err!.code).toBe('PROFESSION_NOT_REQUIRED')
  })

  it('rejects when the profession is already full and says the numbers', () => {
    const err = validateAssignment(shift(), nurse,
      ctx({ claimsByProfession: { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } }), NOW)
    expect(err!.code).toBe('ROLE_FULL')
    expect(err!.message).toContain('2 of 2')
  })

  it('allows a doctor onto a shift whose nurse slots are full', () => {
    expect(validateAssignment(shift(), { id: 8, profession: 'DOCTOR' },
      ctx({ claimsByProfession: { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } }), NOW)).toBeNull()
  })

  it('rejects a shift overlapping one the user already holds', () => {
    const err = validateAssignment(shift(), nurse, ctx({
      userOtherShifts: [{
        startsAt: new Date('2026-08-12T13:00:00Z'),
        endsAt: new Date('2026-08-12T21:00:00Z'),
      }],
    }), NOW)
    expect(err!.code).toBe('OVERLAP')
  })

  it('allows a back-to-back shift that only touches at the boundary', () => {
    expect(validateAssignment(shift(), nurse, ctx({
      userOtherShifts: [{
        startsAt: new Date('2026-08-12T15:00:00Z'),
        endsAt: new Date('2026-08-12T23:00:00Z'),
      }],
    }), NOW)).toBeNull()
  })

  it('rejects a manager with no profession — managers claim as themselves, not as staff', () => {
    const err = validateAssignment(shift(), { id: 1, profession: null }, ctx(), NOW)
    expect(err!.code).toBe('PROFESSION_NOT_REQUIRED')
  })
})
