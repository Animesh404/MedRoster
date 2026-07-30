import { describe, expect, it } from 'vitest'
import { inviteDestination, needsPassword } from '@/app/auth/invite-branch'

describe('needsPassword', () => {
  it('is true for an invitee who arrived by email link', () => {
    expect(needsPassword([{ provider: 'email' }])).toBe(true)
  })

  it('is false for an invitee who accepted via Google', () => {
    expect(needsPassword([{ provider: 'google' }])).toBe(false)
  })

  it('is true when both identities are present, so a password can still be set', () => {
    expect(needsPassword([{ provider: 'google' }, { provider: 'email' }])).toBe(true)
  })

  it('is false for a missing or empty identities array', () => {
    expect(needsPassword(null)).toBe(false)
    expect(needsPassword(undefined)).toBe(false)
    expect(needsPassword([])).toBe(false)
  })
})

// Covers the accept-invite page's actual branch, not just the predicate it's
// built on: a one-character inversion of `needsPassword(...)` in the page
// would either strand an email invitee on a form that never renders, or skip
// password setup entirely for a Google invitee, and the tests above alone
// would not catch it because they never exercise the direction of the branch.
describe('inviteDestination', () => {
  it('sends an email-identity invitee to the set-password form', () => {
    expect(inviteDestination([{ provider: 'email' }])).toBe('set-password')
  })

  it('sends a Google-only invitee straight to the dashboard', () => {
    expect(inviteDestination([{ provider: 'google' }])).toBe('dashboard')
  })

  it('sends an invitee with both identities to the set-password form', () => {
    expect(inviteDestination([{ provider: 'google' }, { provider: 'email' }])).toBe('set-password')
  })

  it('sends a missing or empty identities array to the dashboard', () => {
    expect(inviteDestination(null)).toBe('dashboard')
    expect(inviteDestination(undefined)).toBe('dashboard')
    expect(inviteDestination([])).toBe('dashboard')
  })
})
