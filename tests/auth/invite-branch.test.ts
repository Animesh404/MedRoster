import { describe, expect, it } from 'vitest'
import { needsPassword } from '@/app/auth/invite-branch'

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
