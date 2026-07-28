import { describe, expect, it } from 'vitest'
import {
  METER_ORDER,
  PROFESSION_MARKS,
  STATUS_STYLES,
  buildMeter,
  meterLabel,
} from '@/lib/ui/tokens'

describe('STATUS_STYLES', () => {
  it('covers every coverage status', () => {
    expect(Object.keys(STATUS_STYLES).sort()).toEqual(['EMPTY', 'FULL', 'PARTIAL'])
  })

  it('gives each status a distinct label and glyph, so colour is never the only signal', () => {
    const labels = Object.values(STATUS_STYLES).map((s) => s.label)
    const glyphs = Object.values(STATUS_STYLES).map((s) => s.glyph)
    expect(new Set(labels).size).toBe(3)
    expect(new Set(glyphs).size).toBe(3)
  })
})

describe('PROFESSION_MARKS', () => {
  it('assigns a unique mark to every profession', () => {
    const marks = Object.values(PROFESSION_MARKS)
    expect(new Set(marks).size).toBe(marks.length)
  })

  it('covers every profession in the meter order', () => {
    for (const p of METER_ORDER) expect(PROFESSION_MARKS[p]).toBeTruthy()
  })
})

describe('buildMeter', () => {
  const none = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

  it('renders a partly staffed shift as filled and hollow slots', () => {
    const meter = buildMeter(
      { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 },
      { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
    )
    expect(meter).toEqual([
      { profession: 'NURSE', mark: 'N', filled: 2, required: 3 },
      { profession: 'DOCTOR', mark: 'D', filled: 1, required: 1 },
    ])
  })

  it('omits professions the shift does not require', () => {
    const meter = buildMeter({ DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 }, none)
    // An empty rail for a role the shift never needed would read as a gap.
    expect(meter.map((s) => s.profession)).toEqual(['NURSE'])
  })

  it('keeps a stable profession order so scanning a column is predictable', () => {
    const meter = buildMeter({ DOCTOR: 1, NURSE: 1, RECEPTIONIST: 1 }, none)
    expect(meter.map((s) => s.profession)).toEqual(['NURSE', 'DOCTOR', 'RECEPTIONIST'])
  })

  it('clamps an over-staffed rail rather than overflowing it', () => {
    const meter = buildMeter(
      { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
      { DOCTOR: 0, NURSE: 5, RECEPTIONIST: 0 },
    )
    expect(meter[0]).toEqual({ profession: 'NURSE', mark: 'N', filled: 2, required: 2 })
  })

  it('never reports more filled than required', () => {
    for (const claimed of [0, 1, 2, 3, 9]) {
      const meter = buildMeter(
        { DOCTOR: 0, NURSE: 3, RECEPTIONIST: 0 },
        { DOCTOR: 0, NURSE: claimed, RECEPTIONIST: 0 },
      )
      expect(meter[0]!.filled).toBeLessThanOrEqual(meter[0]!.required)
    }
  })
})

describe('meterLabel', () => {
  it('describes the meter in words for assistive technology', () => {
    const meter = buildMeter(
      { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 },
      { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 },
    )
    expect(meterLabel(meter)).toBe('2 of 3 nurses, 0 of 1 doctor')
  })

  it('singularises a single-slot rail', () => {
    const meter = buildMeter({ DOCTOR: 1, NURSE: 0, RECEPTIONIST: 0 }, { DOCTOR: 1, NURSE: 0, RECEPTIONIST: 0 })
    expect(meterLabel(meter)).toBe('1 of 1 doctor')
  })

  it('says so when a shift requires nobody', () => {
    expect(meterLabel([])).toBe('No staffing required')
  })
})
