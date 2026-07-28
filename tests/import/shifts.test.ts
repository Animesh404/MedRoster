import { describe, expect, it } from 'vitest'
import { parseShiftRows, SHIFT_RULES } from '@/lib/import/shifts'
import { collectLegend, createFieldRule, SHIFT_WINDOW_RULES, STRUCTURAL_RULES } from '@/lib/import/registry'

const HEADER = 'shift_id,date,start_time,end_time,requirements\n'
const one = (line: string) => parseShiftRows(HEADER + line + '\n')[0]!
const codes = (line: string) => one(line).issues.map((i) => i.code)

describe('parseShiftRows — dates', () => {
  it('accepts an ISO date unchanged', () => {
    const r = one('5053,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1')
    expect(r.record!.startsAt.toISOString()).toBe('2026-08-17T07:00:00.000Z') // BST
    expect(r.issues).toEqual([])
  })

  it('reads a slash date as dd/mm/yyyy', () => {
    // 20/08/2026 is 20 August, not an invalid month 20
    const r = one('5065,20/08/2026,08:00,16:00,nurses=2;doctors=1;receptionists=0')
    expect(r.record!.startsAt.toISOString().slice(0, 10)).toBe('2026-08-20')
    expect(codes('5065,20/08/2026,08:00,16:00,nurses=2;doctors=1;receptionists=0')).toContain('DATE_FORMAT')
  })

  it('reads a dash date as mm-dd-yyyy', () => {
    // 08-13-2026 is 13 August — the second field exceeds 12 so it must be the day
    const r = one('5041,08-13-2026,16:00,00:00,nurses=3;doctors=2;receptionists=0')
    expect(r.record!.startsAt.toISOString().slice(0, 10)).toBe('2026-08-13')
  })

  it('rejects a date that does not exist', () => {
    expect(one('5110,2026-02-30,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5110,2026-02-30,08:00,16:00,nurses=1')).toContain('IMPOSSIBLE_DATE')
  })

  it('rejects a slash date where neither field can be the month', () => {
    expect(one('5200,13/14/2026,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5200,13/14/2026,08:00,16:00,nurses=1')).toContain('AMBIGUOUS_DATE')
  })

  it('rejects an unrecognised date shape', () => {
    expect(one('5201,August 5th,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5201,August 5th,08:00,16:00,nurses=1')).toContain('UNPARSEABLE_DATE')
  })

  it('rejects an empty date', () => {
    expect(one('5300,,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5300,,08:00,16:00,nurses=1')).toContain('MISSING_DATE')
  })
})

describe('parseShiftRows — times', () => {
  it('rolls an overnight shift forward a day and keeps it at 8 hours', () => {
    const r = one('5050,2026-08-16,22:00,06:00,nurses=2;doctors=1;receptionists=1')
    expect(r.record!.endsAt.getTime() - r.record!.startsAt.getTime()).toBe(8 * 3_600_000)
    expect(codes('5050,2026-08-16,22:00,06:00,nurses=2;doctors=1;receptionists=1')).toContain('OVERNIGHT_ROLLOVER')
  })

  it('treats a 00:00 end as midnight the next day', () => {
    const r = one('5097,2026-08-28,16:00,00:00,nurses=3;doctors=1;receptionists=0')
    expect(r.record!.endsAt.getTime() - r.record!.startsAt.getTime()).toBe(8 * 3_600_000)
  })

  it('rejects an 18-hour shift', () => {
    expect(one('5109,2026-08-12,15:00,09:00,nurses=2;doctors=1').record).toBeNull()
    expect(codes('5109,2026-08-12,15:00,09:00,nurses=2;doctors=1')).toContain('DURATION_TOO_LONG')
  })

  it('rejects a zero-length shift', () => {
    expect(one('5112,2026-08-15,12:00,12:00,doctors=1').record).toBeNull()
    expect(codes('5112,2026-08-15,12:00,12:00,doctors=1')).toContain('DURATION_TOO_LONG')
  })

  it('rejects an explicit +1 that yields 26 hours', () => {
    expect(one('5115,2026-08-21,08:00,10:00+1,nurses=2').record).toBeNull()
    const rowCodes = codes('5115,2026-08-21,08:00,10:00+1,nurses=2')
    expect(rowCodes).toContain('DURATION_TOO_LONG')
    expect(rowCodes).toContain('EXPLICIT_NEXT_DAY')
  })

  it('rejects a missing start time', () => {
    expect(one('5114,2026-08-20,,16:00,nurses=1;doctors=1').record).toBeNull()
    expect(codes('5114,2026-08-20,,16:00,nurses=1;doctors=1')).toContain('MISSING_TIME')
  })

  it('rejects a badly formatted time', () => {
    expect(one('5302,2026-08-18,25:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5302,2026-08-18,25:00,16:00,nurses=1')).toContain('BAD_TIME_FORMAT')
  })
})

describe('parseShiftRows — requirements', () => {
  it('defaults omitted role keys to zero', () => {
    const r = one('5111,09/08/2026,10:00,18:00,nurses=2')
    expect(r.record!.requirements).toEqual({ DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 })
    expect(codes('5111,09/08/2026,10:00,18:00,nurses=2')).toContain('REQUIREMENT_DEFAULTED')
  })

  it('rejects free-text requirements rather than guessing', () => {
    expect(one('5113,2026-08-18,08:00,16:00,two nurses and a doctor').record).toBeNull()
    expect(codes('5113,2026-08-18,08:00,16:00,two nurses and a doctor')).toContain('UNPARSEABLE_REQUIREMENTS')
  })

  it('rejects a shift that needs nobody', () => {
    expect(one('5202,2026-08-18,08:00,16:00,nurses=0;doctors=0;receptionists=0').record).toBeNull()
    expect(codes('5202,2026-08-18,08:00,16:00,nurses=0;doctors=0;receptionists=0')).toContain('ZERO_HEADCOUNT')
  })

  it('rejects an unknown requirement key', () => {
    expect(one('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1').record).toBeNull()
    expect(codes('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1')).toContain('UNKNOWN_REQUIREMENT_KEY')
  })
})

describe('parseShiftRows — ids and structure', () => {
  it('rejects a non-numeric shift id', () => {
    expect(one('abc,2026-08-18,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('abc,2026-08-18,08:00,16:00,nurses=1')).toContain('INVALID_ID')
  })

  it('rejects a row with the wrong number of columns', () => {
    expect(one('5303,2026-08-18,08:00,16:00').record).toBeNull()
    expect(codes('5303,2026-08-18,08:00,16:00')).toContain('BAD_ARITY')
  })
})

describe('parseShiftRows — reporting', () => {
  it('keeps the raw line and file line number for the report', () => {
    const r = one('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1')
    expect(r.rowNumber).toBe(2)
    expect(r.raw).toBe('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1')
  })
})

describe('parseShiftRows — whitespace repairs (review Finding 1 regression)', () => {
  // Regression guard: dateRule's ISO branch and makeTimeRule's run used to
  // only ever call `fatal(...)`, with no `repairing(...)` path at all — so a
  // cell whose ONLY defect was surrounding whitespace was trimmed with ZERO
  // manager-facing evidence. The slash/dash date branch caught it only
  // incidentally, as a side effect of its DATE_FORMAT repair.

  it('emits a whitespace repair for a padded ISO date with no other defect', () => {
    const r = one('9005,2026-08-18 ,08:00,16:00,nurses=1;doctors=1;receptionists=1')
    expect(r.record).not.toBeNull()
    const ws = r.issues.filter((i) => i.code === 'DATE_WHITESPACE')
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ field: 'date', before: '2026-08-18 ', after: '2026-08-18' })
  })

  it('emits a whitespace repair for a padded start_time', () => {
    const r = one('9006,2026-08-18, 08:00 ,16:00,nurses=1;doctors=1;receptionists=1')
    expect(r.record).not.toBeNull()
    const ws = r.issues.filter((i) => i.code === 'TIME_WHITESPACE')
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ field: 'start_time', before: ' 08:00 ', after: '08:00' })
  })

  it('emits a whitespace repair for a padded end_time', () => {
    const r = one('9007,2026-08-18,08:00, 16:00 ,nurses=1;doctors=1;receptionists=1')
    expect(r.record).not.toBeNull()
    const ws = r.issues.filter((i) => i.code === 'TIME_WHITESPACE')
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ field: 'end_time', before: ' 16:00 ', after: '16:00' })
  })

  it('emits a whitespace repair for a padded requirements cell', () => {
    const r = one('9008,2026-08-18,08:00,16:00, nurses=1;doctors=1;receptionists=1 ')
    expect(r.record).not.toBeNull()
    const ws = r.issues.filter((i) => i.code === 'REQUIREMENTS_WHITESPACE')
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({
      field: 'requirements',
      before: ' nurses=1;doctors=1;receptionists=1 ',
      after: 'nurses=1;doctors=1;receptionists=1',
    })
  })

  it('emits no whitespace repair for a clean row', () => {
    const r = one('9009,2026-08-18,08:00,16:00,nurses=1;doctors=1;receptionists=1')
    expect(r.issues).toEqual([])
  })
})

describe('SHIFT_RULES — registry legend (Amendment A)', () => {
  it('throws when a duplicate descriptor disagrees about what a code means', () => {
    const conflicting = createFieldRule({
      emits: [{
        code: 'MISSING_DATE',
        field: 'date',
        severity: 'FATAL' as const,
        describe: 'A deliberately conflicting description that does not match the real one.',
      }],
      run: (input: string) => input,
    })
    expect(() => collectLegend([...SHIFT_RULES, conflicting])).toThrow()
  })

  it('every issue code parseShiftRows can emit — including BAD_ARITY (STRUCTURAL_RULES) and ' +
     'OVERNIGHT_ROLLOVER, EXPLICIT_NEXT_DAY, DURATION_TOO_LONG (SHIFT_WINDOW_RULES), all pushed ' +
     'directly by parseShiftRows rather than by any single-cell FieldRule — is covered by the ' +
     'union of collectLegend(SHIFT_RULES), STRUCTURAL_RULES and SHIFT_WINDOW_RULES', () => {
    const legendCodes = new Set([
      ...collectLegend(SHIFT_RULES).map((d) => d.code),
      ...STRUCTURAL_RULES.map((d) => d.code),
      ...SHIFT_WINDOW_RULES.map((d) => d.code),
    ])

    const emittedCodes = new Set<string>()
    const lines = [
      '5053,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1', // clean
      '5065,20/08/2026,08:00,16:00,nurses=2;doctors=1;receptionists=0', // DATE_FORMAT
      '5110,2026-02-30,08:00,16:00,nurses=1',                          // IMPOSSIBLE_DATE
      '5200,13/14/2026,08:00,16:00,nurses=1',                          // AMBIGUOUS_DATE
      '5201,August 5th,08:00,16:00,nurses=1',                          // UNPARSEABLE_DATE
      '5300,,08:00,16:00,nurses=1',                                    // MISSING_DATE
      '5050,2026-08-16,22:00,06:00,nurses=2;doctors=1;receptionists=1',// OVERNIGHT_ROLLOVER
      '5109,2026-08-12,15:00,09:00,nurses=2;doctors=1',                // DURATION_TOO_LONG
      '5115,2026-08-21,08:00,10:00+1,nurses=2',                        // EXPLICIT_NEXT_DAY + DURATION_TOO_LONG
      '5114,2026-08-20,,16:00,nurses=1;doctors=1',                     // MISSING_TIME
      '5302,2026-08-18,25:00,16:00,nurses=1',                          // BAD_TIME_FORMAT
      '5111,09/08/2026,10:00,18:00,nurses=2',                          // REQUIREMENT_DEFAULTED
      '5113,2026-08-18,08:00,16:00,two nurses and a doctor',           // UNPARSEABLE_REQUIREMENTS
      '5202,2026-08-18,08:00,16:00,nurses=0;doctors=0;receptionists=0',// ZERO_HEADCOUNT
      '5203,2026-08-18,08:00,16:00,janitors=1;nurses=1',               // UNKNOWN_REQUIREMENT_KEY
      'abc,2026-08-18,08:00,16:00,nurses=1',                           // INVALID_ID
      '5303,2026-08-18,08:00,16:00',                                   // BAD_ARITY
      '9005,2026-08-18 ,08:00,16:00,nurses=1;doctors=1;receptionists=1', // DATE_WHITESPACE
      '9006,2026-08-18, 08:00 ,16:00,nurses=1;doctors=1;receptionists=1', // TIME_WHITESPACE
      '9008,2026-08-18,08:00,16:00, nurses=1;doctors=1;receptionists=1 ', // REQUIREMENTS_WHITESPACE
    ]
    for (const line of lines) {
      for (const issue of one(line).issues) emittedCodes.add(issue.code)
    }

    expect(emittedCodes.has('BAD_ARITY')).toBe(true)
    expect(emittedCodes.has('OVERNIGHT_ROLLOVER')).toBe(true)
    expect(emittedCodes.has('EXPLICIT_NEXT_DAY')).toBe(true)
    expect(emittedCodes.has('DURATION_TOO_LONG')).toBe(true)
    for (const code of emittedCodes) {
      expect(legendCodes.has(code)).toBe(true)
    }
  })
})
