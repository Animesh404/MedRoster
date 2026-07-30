import { describe, expect, it } from 'vitest'
import { checkRoster } from '@/lib/auth/roster-gate'

describe('checkRoster', () => {
  it('allows an active member', () => {
    expect(checkRoster({ deactivatedAt: null })).toEqual({ allowed: true })
  })

  it('refuses someone with no profile, naming the remedy', () => {
    const result = checkRoster(null)
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/ask a manager for an invite/i)
  })

  it('refuses a deactivated member', () => {
    const result = checkRoster({ deactivatedAt: new Date('2026-01-01') })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/no longer active/i)
  })
})
