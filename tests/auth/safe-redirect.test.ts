import { describe, expect, it } from 'vitest'
import { safeNextPath } from '@/lib/auth/safe-redirect'

const FALLBACK = '/dashboard'

describe('safeNextPath', () => {
  it('passes through a legitimate relative path unchanged', () => {
    expect(safeNextPath('/shifts/12')).toBe('/shifts/12')
  })

  it('preserves query string and fragment on a legitimate path', () => {
    expect(safeNextPath('/shifts/12?week=2026-W31')).toBe('/shifts/12?week=2026-W31')
  })

  it('rejects an absolute URL with a scheme', () => {
    expect(safeNextPath('https://evil.example')).toBe(FALLBACK)
  })

  it('rejects an absolute http URL with a scheme', () => {
    expect(safeNextPath('http://evil.example/dashboard')).toBe(FALLBACK)
  })

  it('rejects a protocol-relative URL', () => {
    expect(safeNextPath('//evil.example')).toBe(FALLBACK)
  })

  it('rejects the backslash protocol-relative variant', () => {
    expect(safeNextPath('/\\evil.example')).toBe(FALLBACK)
  })

  it('rejects the doubled backslash-then-slash variant', () => {
    expect(safeNextPath('/\\/evil.example')).toBe(FALLBACK)
  })

  it('rejects an empty string', () => {
    expect(safeNextPath('')).toBe(FALLBACK)
  })

  it('rejects a whitespace-only string', () => {
    expect(safeNextPath('   ')).toBe(FALLBACK)
  })

  it('rejects null', () => {
    expect(safeNextPath(null)).toBe(FALLBACK)
  })

  it('rejects undefined', () => {
    expect(safeNextPath(undefined)).toBe(FALLBACK)
  })

  it('rejects a value with no leading slash at all', () => {
    expect(safeNextPath('evil.example')).toBe(FALLBACK)
  })
})
