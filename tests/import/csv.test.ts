import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitCsv } from '@/lib/import/csv'

describe('splitCsv', () => {
  it('reports 1-based row numbers that match the file (header is line 1)', () => {
    const { rows } = splitCsv('a,b\n1,2\n3,4\n')
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3])
  })

  it('preserves the raw line verbatim for the import report', () => {
    const { rows } = splitCsv('a,b\n  x , y \n')
    expect(rows[0]!.raw).toBe('  x , y ')
    expect(rows[0]!.cells).toEqual(['  x ', ' y '])
  })

  it('handles quoted cells containing commas', () => {
    const { rows } = splitCsv('a,b\n"Doe, Jane",nurse\n')
    expect(rows[0]!.cells).toEqual(['Doe, Jane', 'nurse'])
  })

  it('skips blank lines and tolerates CRLF', () => {
    const { rows } = splitCsv('a,b\r\n1,2\r\n\r\n3,4\r\n')
    expect(rows).toHaveLength(2)
  })

  it('does not pad or truncate short rows — arity is the caller\'s problem', () => {
    const { rows } = splitCsv('a,b,c\n1,2\n')
    expect(rows[0]!.cells).toHaveLength(2)
  })

  // --- Finding 1: a stray mid-field quote must not swallow the rest of the field ---

  describe('Finding 1 — quotes are only significant at the start of a field', () => {
    it('treats a mid-field quote as a literal character, keeping correct cell count', () => {
      const { rows } = splitCsv('a,b\nfo"o,bar\n')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.cells).toEqual(['fo"o', 'bar'])
    })

    it('still opens a quoted section when the quote is the first character of a field', () => {
      const { rows } = splitCsv('a,b\n"Doe, Jane",bar\n')
      expect(rows[0]!.cells).toEqual(['Doe, Jane', 'bar'])
    })

    it('handles an escaped "" quote inside a properly-opened quoted field', () => {
      const { rows } = splitCsv('a,b\n"She said ""hi""",bar\n')
      expect(rows[0]!.cells).toEqual(['She said "hi"', 'bar'])
    })

    it('an inch-mark typo mid-name does not corrupt the column count', () => {
      const { rows } = splitCsv('name,role\n5"11 Jones,Nurse\n')
      expect(rows[0]!.cells).toEqual(['5"11 Jones', 'Nurse'])
    })
  })

  // --- Finding 2: quoted cells may legitimately contain embedded newlines ---

  describe('Finding 2 — embedded newlines inside quoted cells', () => {
    it('keeps a quoted embedded newline as one row, not two', () => {
      const { rows } = splitCsv('a,b\n"line one\nline two",bar\n')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.cells).toEqual(['line one\nline two', 'bar'])
    })

    it('raw includes the embedded newline, and rowNumber is the starting line', () => {
      const text = 'a,b\n"line one\nline two",bar\nc,d\n'
      const { rows } = splitCsv(text)
      expect(rows).toHaveLength(2)
      expect(rows[0]!.rowNumber).toBe(2)
      expect(rows[0]!.raw).toBe('"line one\nline two",bar')
      // The second record starts on line 4 (line 2 spans two physical lines).
      expect(rows[1]!.rowNumber).toBe(4)
      expect(rows[1]!.raw).toBe('c,d')
    })

    it('handles an embedded CRLF inside a quoted cell', () => {
      const { rows } = splitCsv('a,b\r\n"line one\r\nline two",bar\r\n')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.cells).toEqual(['line one\r\nline two', 'bar'])
    })

    it('preserves ordinary single-line raw/rowNumber behaviour unchanged', () => {
      const { rows } = splitCsv('a,b\n1,2\n3,4\n')
      expect(rows.map((r) => r.rowNumber)).toEqual([2, 3])
      expect(rows.map((r) => r.raw)).toEqual(['1,2', '3,4'])
    })
  })

  // --- Finding 3: empty / whitespace-only input must not yield a phantom header ---

  describe('Finding 3 — empty input', () => {
    it('returns no header and no rows for a fully empty string', () => {
      expect(splitCsv('')).toEqual({ header: [], rows: [] })
    })

    it('returns no header and no rows for whitespace-only input', () => {
      expect(splitCsv('   \n  \n')).toEqual({ header: [], rows: [] })
    })

    it('still returns the header for a header-only file with no data rows', () => {
      const { header, rows } = splitCsv('a,b,c\n')
      expect(header).toEqual(['a', 'b', 'c'])
      expect(rows).toEqual([])
    })
  })

  // --- Unterminated quote at EOF must not crash ---

  describe('unterminated quote at EOF', () => {
    it('treats the rest of the input as the final literal cell instead of throwing', () => {
      const { rows } = splitCsv('a,b\n"foo,bar')
      expect(() => splitCsv('a,b\n"foo,bar')).not.toThrow()
      expect(rows).toHaveLength(1)
      // Everything after the opening quote — including the embedded comma,
      // since it is consumed as quoted data — becomes one final cell.
      expect(rows[0]!.cells).toEqual(['foo,bar'])
    })
  })

  // --- Interspersed blank lines beyond the simple CRLF case above ---

  describe('interspersed blank lines and trailing newline variants', () => {
    it('skips several non-consecutive blank lines', () => {
      const { rows } = splitCsv('a,b\n1,2\n\n\n3,4\n\n5,6\n')
      expect(rows.map((r) => r.cells)).toEqual([['1', '2'], ['3', '4'], ['5', '6']])
      expect(rows.map((r) => r.rowNumber)).toEqual([2, 5, 7])
    })

    it('handles input with no trailing newline at all', () => {
      const { rows } = splitCsv('a,b\n1,2')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.raw).toBe('1,2')
    })
  })

  // --- Regression guard against the real fixture files ---

  describe('regression: real fixture files', () => {
    const staffPath = path.join(process.cwd(), 'staff.csv')
    const shiftsPath = path.join(process.cwd(), 'shifts.csv')
    const staffText = readFileSync(staffPath, 'utf8')
    const shiftsText = readFileSync(shiftsPath, 'utf8')

    it('splitCsv(staff.csv) yields exactly 41 data rows', () => {
      const { rows } = splitCsv(staffText)
      expect(rows).toHaveLength(41)
    })

    it('splitCsv(shifts.csv) yields exactly 117 data rows', () => {
      const { rows } = splitCsv(shiftsText)
      expect(rows).toHaveLength(117)
    })

    it('the first data row of staff.csv starts at rowNumber 2 and raw round-trips byte-identically', () => {
      const { rows } = splitCsv(staffText)
      const sourceLines = staffText.split(/\r?\n/)
      expect(rows[0]!.rowNumber).toBe(2)
      expect(rows[0]!.raw).toBe(sourceLines[1])
    })

    it('the first data row of shifts.csv starts at rowNumber 2 and raw round-trips byte-identically', () => {
      const { rows } = splitCsv(shiftsText)
      const sourceLines = shiftsText.split(/\r?\n/)
      expect(rows[0]!.rowNumber).toBe(2)
      expect(rows[0]!.raw).toBe(sourceLines[1])
    })
  })
})
