import { describe, expect, it } from 'vitest'
import { parseDbId } from '@/lib/contracts/common'

// IMP-2: `Number.isInteger(Number(raw))` (the pattern this replaces) accepts
// far more than a real database id — out-of-Int32-range values, scientific
// notation, hex, padded/whitespace strings, and `''` (`Number('') === 0`).
// Every one of those either 500s once it reaches Prisma or silently
// resolves to the wrong row. `parseDbId` must reject all of them.
describe('parseDbId', () => {
  it('accepts a plain positive integer string', () => {
    expect(parseDbId('1')).toBe(1)
    expect(parseDbId('42')).toBe(42)
  })

  it('accepts the Postgres Int32 max but rejects one past it', () => {
    expect(parseDbId('2147483647')).toBe(2_147_483_647)
    expect(parseDbId('2147483648')).toBeNull()
  })

  it('rejects scientific notation', () => {
    expect(parseDbId('1e21')).toBeNull()
  })

  it('rejects hex', () => {
    expect(parseDbId('0x10')).toBeNull()
  })

  it('rejects a padded/whitespace string', () => {
    expect(parseDbId(' 1 ')).toBeNull()
  })

  it('rejects the empty string (Number(\'\') === 0, which is technically an integer)', () => {
    expect(parseDbId('')).toBeNull()
  })

  it('rejects zero and negative numbers', () => {
    expect(parseDbId('0')).toBeNull()
    expect(parseDbId('-1')).toBeNull()
  })

  it('rejects a decimal', () => {
    expect(parseDbId('1.5')).toBeNull()
  })
})
