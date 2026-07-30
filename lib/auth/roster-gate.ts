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

export interface EmailRosterProfile extends RosterProfile {
  authUserId: string | null
}

/**
 * The roster gate for flows that identify someone by EMAIL rather than by
 * Supabase uid — magic link, OAuth callback, password recovery.
 *
 * Strictly stronger than `checkRoster`, and the difference is the point. A
 * profile looked up by `authUserId` necessarily has one; a profile looked up by
 * email may be an imported `staff.csv` row that was never invited
 * (`authUserId: null`). Those rows carry a real, guessable work address, so
 * admitting them would let anyone who knows a colleague's email request a
 * magic link and sign in as them.
 *
 * Order matters: a deactivated member gets the deactivated reason even if they
 * also have no `authUserId`, because "your access was removed" is the true and
 * more useful answer.
 */
export function checkRosterByEmail(profile: EmailRosterProfile | null): GateResult {
  const base = checkRoster(profile)
  if (!base.allowed) return base
  if (!profile!.authUserId) {
    return {
      allowed: false,
      reason: "This email isn't on the roster — ask a manager for an invite.",
    }
  }
  return { allowed: true }
}
