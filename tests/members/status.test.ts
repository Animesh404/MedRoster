import { describe, expect, it } from 'vitest'
import { memberStatus } from '@/lib/members/status'

const NEVER_INVITED = { authUserId: null, deactivatedAt: null, authUser: null }

describe('memberStatus', () => {
  it('is no-account for an imported profile that was never invited', () => {
    expect(memberStatus(NEVER_INVITED)).toBe('no-account')
  })

  it('is invited when the auth user exists but has not confirmed', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: null, authUser: { confirmedAt: null },
    })).toBe('invited')
  })

  it('is active once the invite has been accepted', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: null, authUser: { confirmedAt: new Date() },
    })).toBe('active')
  })

  it('is deactivated regardless of confirmation state', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: new Date(), authUser: { confirmedAt: new Date() },
    })).toBe('deactivated')
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: new Date(), authUser: { confirmedAt: null },
    })).toBe('deactivated')
  })

  // Drift between the two stores is possible — a Supabase user deleted from the
  // dashboard leaves a linked profile behind. Reporting that as `active` would
  // show a manager someone who cannot sign in, so it degrades to no-account.
  it('degrades to no-account when the linked auth user has vanished', () => {
    expect(memberStatus({
      authUserId: 'uid-gone', deactivatedAt: null, authUser: null,
    })).toBe('no-account')
  })

  it('still reports deactivated when the auth user has vanished', () => {
    expect(memberStatus({
      authUserId: 'uid-gone', deactivatedAt: new Date(), authUser: null,
    })).toBe('deactivated')
  })
})
