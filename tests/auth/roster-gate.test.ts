import { describe, expect, it } from 'vitest'
import { checkRoster, checkRosterByEmail } from '@/lib/auth/roster-gate'

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

describe('checkRosterByEmail', () => {
  it('allows an active member who has an account', () => {
    expect(checkRosterByEmail({ deactivatedAt: null, authUserId: 'uid-1' }))
      .toEqual({ allowed: true })
  })

  it('refuses an address with no profile at all', () => {
    const result = checkRosterByEmail(null)
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/ask a manager for an invite/i)
  })

  // The reason this function exists. An imported staff row has a profile and a
  // real email but was never invited, so authUserId is null. Keyed by
  // authUserId those rows cannot be found at all; keyed by EMAIL they can, and
  // treating one as a member would let anyone who knows a colleague's address
  // sign in as them via magic link.
  it('refuses a profile that was never invited, even though it exists', () => {
    const result = checkRosterByEmail({ deactivatedAt: null, authUserId: null })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/ask a manager for an invite/i)
  })

  it('refuses a deactivated member who does have an account', () => {
    const result = checkRosterByEmail({ deactivatedAt: new Date('2026-01-01'), authUserId: 'uid-2' })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/no longer active/i)
  })

  it('prefers the deactivated reason when a member is both deactivated and unlinked', () => {
    const result = checkRosterByEmail({ deactivatedAt: new Date('2026-01-01'), authUserId: null })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/no longer active/i)
  })
})
