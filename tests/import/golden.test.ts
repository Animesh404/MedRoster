import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'

const rejectedIds = (r: { rows: { outcome: string; raw: string }[] }) =>
  r.rows.filter((x) => x.outcome === 'REJECTED').map((x) => Number(x.raw.split(',')[0])).sort((a, b) => a - b)

const mergedIds = (r: { rows: { outcome: string; raw: string }[] }) =>
  r.rows.filter((x) => x.outcome === 'MERGED').map((x) => Number(x.raw.split(',')[0])).sort((a, b) => a - b)

describe('golden file — staff.csv', () => {
  const result = runStaffImport(readFileSync('staff.csv', 'utf8'))

  it('produces exactly 34 accepted, 3 merged, 4 rejected of 41', () => {
    expect(result.stats).toEqual({ accepted: 34, merged: 3, rejected: 4, total: 41 })
  })

  it('rejects exactly the four known-bad rows', () => {
    expect(rejectedIds(result)).toEqual([995, 996, 997, 998])
  })

  it('merges exactly the three known-duplicate rows', () => {
    expect(mergedIds(result)).toEqual([103, 110, 999])
  })

  it('keeps all 34 real staff ids in 100..133', () => {
    const ids = result.accepted.map((s) => s.externalId).sort((a, b) => a - b)
    expect(ids).toHaveLength(34)
    expect(ids[0]).toBe(100)
    expect(ids.at(-1)).toBe(133)
  })

  // Counted per distinct PERSON after merging, not per raw row — the two
  // byte-identical duplicate rows (staff 103, a receptionist, and staff 110,
  // a nurse) each collapse into a single accepted record, so counting rows
  // instead of `result.accepted` overcounts both NURSE and RECEPTIONIST by
  // one and produces a total that cannot equal the accepted count.
  it('yields 16 nurses, 8 doctors and 10 receptionists', () => {
    const count = (p: string) => result.accepted.filter((s) => s.profession === p).length
    expect({ NURSE: count('NURSE'), DOCTOR: count('DOCTOR'), RECEPTIONIST: count('RECEPTIONIST') })
      .toEqual({ NURSE: 16, DOCTOR: 8, RECEPTIONIST: 10 })
  })

  // Invariant: every accepted staff record has exactly one profession, so the
  // three per-profession counts must always sum to the accepted total. A
  // hardcoded triple that doesn't satisfy this is a bug in the expectation,
  // not the importer — this is exactly the error the 17/8/11 typo above made.
  it('profession counts sum to the total accepted', () => {
    const count = (p: string) => result.accepted.filter((s) => s.profession === p).length
    expect(count('NURSE') + count('DOCTOR') + count('RECEPTIONIST')).toBe(result.accepted.length)
  })
})

describe('golden file — shifts.csv', () => {
  const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))

  it('produces exactly 109 accepted, 2 merged, 6 rejected of 117', () => {
    expect(result.stats).toEqual({ accepted: 109, merged: 2, rejected: 6, total: 117 })
  })

  it('rejects exactly the six known-bad rows', () => {
    expect(rejectedIds(result)).toEqual([5109, 5110, 5112, 5113, 5114, 5115])
  })

  it('merges the duplicate row and the duplicate id', () => {
    expect(mergedIds(result)).toEqual([5020, 5054])
  })

  it('spans 2026-08-03 to 2026-08-30', () => {
    const days = result.accepted.map((s) => s.startsAt.toISOString().slice(0, 10)).sort()
    expect(days[0]).toBe('2026-08-03')
    expect(days.at(-1)).toBe('2026-08-30')
  })

  // Sum is over the ACCEPTED set only: shift 5054 (nurses=3, doctors=1,
  // receptionists=1) is merged away into 5053 and must not be double-counted,
  // while shift 5111 (nurses=2, an accepted row that only carries a repair)
  // must be included. Summing over the raw id range 5000-5108 instead of the
  // accepted set — as the original 226/115/47 figure did — wrongly includes
  // 5054 and wrongly excludes 5111.
  it('requires 225 nurse, 114 doctor and 46 receptionist slots in total', () => {
    const sum = (p: 'NURSE' | 'DOCTOR' | 'RECEPTIONIST') =>
      result.accepted.reduce((a, s) => a + s.requirements[p], 0)
    expect({ NURSE: sum('NURSE'), DOCTOR: sum('DOCTOR'), RECEPTIONIST: sum('RECEPTIONIST') })
      .toEqual({ NURSE: 225, DOCTOR: 114, RECEPTIONIST: 46 })
  })

  it('never emits two shifts with the same id', () => {
    const ids = result.accepted.map((s) => s.externalId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
