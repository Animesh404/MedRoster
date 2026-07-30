export interface RosterProfile {
  deactivatedAt: Date | null
}

export type GateResult = { allowed: true } | { allowed: false; reason: string }

/**
 * Whether an authenticated identity belongs to someone on the roster.
 *
 * Deliberately pure and profile-shaped rather than doing its own lookup: this
 * is the security decision behind sign-in, magic link and OAuth callback
 * alike, and it should be exhaustively testable without a database, a browser
 * or a network. Callers do the lookup and hand the answer in.
 */
export function checkRoster(profile: RosterProfile | null): GateResult {
  if (!profile) {
    return {
      allowed: false,
      reason: "This email isn't on the roster — ask a manager for an invite.",
    }
  }
  if (profile.deactivatedAt) {
    return { allowed: false, reason: 'This account is no longer active.' }
  }
  return { allowed: true }
}
