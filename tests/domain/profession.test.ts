import { describe, expect, it } from 'vitest'
import { parseProfession } from '@/lib/domain/profession'

describe('parseProfession', () => {
  it.each([
    ['NURSE', 'NURSE'], ['nurse', 'NURSE'], ['RN', 'NURSE'],
    ['Registered Nurse', 'NURSE'], ['  Nurse  ', 'NURSE'],
    ['Doctor', 'DOCTOR'], ['DOCTOR ', 'DOCTOR'], ['MD', 'DOCTOR'], ['Physician', 'DOCTOR'],
    ['receptionist', 'RECEPTIONIST'], ['Reception', 'RECEPTIONIST'],
    ['recep.', 'RECEPTIONIST'], ['Receptionist', 'RECEPTIONIST'],
  ])('maps %j to %s', (raw, expected) => {
    expect(parseProfession(raw)).toBe(expected)
  })

  it.each([['Janitor'], [''], ['   '], ['Surgeon']])('rejects %j', (raw) => {
    expect(parseProfession(raw)).toBeNull()
  })
})
