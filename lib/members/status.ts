export type MemberStatus = 'active' | 'invited' | 'deactivated' | 'no-account'

export interface StatusInputs {
  /** Supabase auth.users.id, or null for a profile that was never invited. */
  authUserId: string | null
  deactivatedAt: Date | null
  /** The matching Supabase user, or null if none was found for this uid. */
  authUser: { confirmedAt: Date | null } | null
}

/**
 * Account status is DERIVED, never stored (spec §3.1).
 *
 * A stored status column would be a second source of truth that drifts from
 * Supabase the moment anyone touches the dashboard — and the drift is invisible
 * until someone cannot sign in. Deriving costs one `admin.listUsers()` call
 * joined in memory and cannot go stale.
 */
export function memberStatus({ authUserId, deactivatedAt, authUser }: StatusInputs): MemberStatus {
  if (deactivatedAt) return 'deactivated'
  if (!authUserId || !authUser) return 'no-account'
  return authUser.confirmedAt ? 'active' : 'invited'
}
