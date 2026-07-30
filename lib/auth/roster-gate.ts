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
 *
 * Every current caller looks the profile up by `authUserId` (a Supabase user
 * that already exists), which means an imported staff row that was never
 * invited — no `authUserId` yet — is unreachable here today: there's no
 * Supabase session for it to attach to, so `checkRoster` never even gets
 * called for that row. That stops being true the moment a caller looks a
 * profile up by EMAIL instead (e.g. a future magic-link or invite-status
 * check performed before a Supabase account exists). Such a caller MUST also
 * verify the profile has a non-null `authUserId` before treating it as
 * allowed — otherwise a CSV-imported row that was never actually invited
 * would pass this gate.
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
