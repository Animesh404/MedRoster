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
