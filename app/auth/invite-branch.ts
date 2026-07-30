/** The `identities` array Supabase returns on a user, narrowed to what matters. */
export interface IdentityLike { provider: string }

/**
 * Whether this member still needs to set a password.
 *
 * False for someone who accepted via Google: identity linking removes the
 * unconfirmed email identity, so they have no password and nothing to set.
 * Showing them a set-password form would strand them on a screen that cannot
 * succeed (spec §5.4.2).
 */
export function needsPassword(identities: IdentityLike[] | null | undefined): boolean {
  return (identities ?? []).some((i) => i.provider === 'email')
}

/**
 * Where accept-invite should send this member, as a plain value rather than
 * a branch buried in the Server Component. `needsPassword` itself is well
 * tested, but the page's `if (!needsPassword(...))` wiring was not — a
 * one-character inversion there would either strand an email invitee on a
 * form that never renders, or skip password setup entirely for them, and
 * nothing would catch it. Extracting the decision here lets the page do
 * nothing but call this and act, so this function is the thing under test.
 */
export function inviteDestination(identities: IdentityLike[] | null | undefined): 'set-password' | 'dashboard' {
  return needsPassword(identities) ? 'set-password' : 'dashboard'
}
