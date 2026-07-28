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
})
