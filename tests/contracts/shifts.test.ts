import { describe, expect, it } from 'vitest'
import {
  createShiftSchema, deletePreviewSchema, droppedClaimSchema,
  isoDateSchema, localDateTimeSchema, shiftHolderSchema,
} from '@/lib/contracts/shifts'

// IMP-1: the old regex-only schema shape-checked but never value-checked —
// `Date.UTC` silently overflow-normalises out-of-range components, so
// `2026-02-31` became `2026-03-03` and `2026-99-99` became a date years
// away, with no error at any layer.
describe('isoDateSchema / localDateTimeSchema (IMP-1)', () => {
  it('accepts a real calendar date', () => {
    expect(isoDateSchema.safeParse('2026-08-12').success).toBe(true)
  })

  it('rejects a day that does not exist in that month', () => {
    expect(isoDateSchema.safeParse('2026-02-31').success).toBe(false)
  })

  it('rejects a nonsense month/day', () => {
    expect(isoDateSchema.safeParse('2026-99-99').success).toBe(false)
  })

  it('accepts Feb 29 in a leap year but rejects it otherwise', () => {
    expect(isoDateSchema.safeParse('2024-02-29').success).toBe(true)
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false)
  })

  it('rejects an impossible time of day', () => {
    const base = { date: '2026-08-12', endTime: '16:00' }
    expect(localDateTimeSchema.safeParse({ ...base, startTime: '99:99' }).success).toBe(false)
    expect(localDateTimeSchema.safeParse({ ...base, startTime: '08:00' }).success).toBe(true)
  })

  it('rejects an impossible end time', () => {
    expect(localDateTimeSchema.safeParse({
      date: '2026-08-12', startTime: '08:00', endTime: '88:88',
    }).success).toBe(false)
  })

  it('accepts a real, fully valid date+time', () => {
    expect(localDateTimeSchema.safeParse({
      date: '2026-08-12', startTime: '08:00', endTime: '16:00',
    }).success).toBe(true)
  })
})

// MIN-5: an unbounded `untilDate` let `occurrenceDates` silently clip at its
// 366-row safety cap with no signal to the caller. The schema now bounds
// `untilDate` to within a year of `date` as defense in depth, on top of the
// route-level truncation check (tests/api/shifts.test.ts).
describe('createShiftSchema recurrence bounds (MIN-5)', () => {
  const base = {
    date: '2026-08-03', startTime: '08:00', endTime: '16:00',
    requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 },
  }

  it('rejects an untilDate far beyond a year out', () => {
    const result = createShiftSchema.safeParse({
      ...base, recurrence: { weekdays: [1], untilDate: '9999-12-31' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an untilDate before date', () => {
    const result = createShiftSchema.safeParse({
      ...base, recurrence: { weekdays: [1], untilDate: '2026-07-01' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed untilDate rather than silently coercing it', () => {
    const result = createShiftSchema.safeParse({
      ...base, recurrence: { weekdays: [1], untilDate: '9999-99-99' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts an untilDate within a year', () => {
    const result = createShiftSchema.safeParse({
      ...base, recurrence: { weekdays: [1], untilDate: '2026-08-24' },
    })
    expect(result.success).toBe(true)
  })
})

// MIN-3: the profession enum used to be re-declared inline at two sites
// instead of importing the canonical `PROFESSION`. Both schemas should
// still only accept the three real professions and reject anything else.
describe('droppedClaimSchema / shiftHolderSchema use the canonical PROFESSION enum (MIN-3)', () => {
  it('accepts each real profession and null', () => {
    for (const profession of ['DOCTOR', 'NURSE', 'RECEPTIONIST', null]) {
      expect(droppedClaimSchema.safeParse({
        userId: 1, name: 'A', profession, code: 'OVERLAP', reason: 'x',
      }).success).toBe(true)
      expect(shiftHolderSchema.safeParse({ userId: 1, name: 'A', profession }).success).toBe(true)
    }
  })

  it('rejects a bogus profession', () => {
    expect(droppedClaimSchema.safeParse({
      userId: 1, name: 'A', profession: 'WIZARD', code: 'OVERLAP', reason: 'x',
    }).success).toBe(false)
  })
})

describe('deletePreviewSchema', () => {
  it('accepts the real previewShiftDelete shape', () => {
    expect(deletePreviewSchema.safeParse({
      version: 0, claimsToken: '0:', holders: [{ userId: 1, name: 'A', profession: 'NURSE' }],
    }).success).toBe(true)
  })
})
