import type { PrismaClient, Profession, Role } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'

/**
 * The slice of `supabase.auth.admin` this module uses.
 *
 * A narrow port rather than a `SupabaseClient` so the branching below —
 * adoption, re-invite refusal, orphan cleanup — is testable against an
 * in-memory fake. Mirrors `lib/seed/auth-accounts.ts`'s `AuthAdminPort`.
 */
export interface InviteAdminPort {
  inviteUserByEmail(
    email: string,
    options?: { redirectTo?: string },
  ): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  updateUserById(
    id: string,
    attrs: { app_metadata?: Record<string, unknown> },
  ): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  /**
   * Unused by invite/resend/revoke — kept on the port for Task 5's
   * members-list route adapter, which lists Supabase users against the
   * roster and reads `confirmed_at` to distinguish an accepted invite from
   * a pending one (see `lib/members/status.ts`).
   */
  listUsers(): Promise<{ data: { users: { id: string; email?: string; confirmed_at?: string }[] }; error: unknown }>
  /**
   * A single-key lookup, used by `revokeInvite` to tell a pending invite from
   * an accepted account. Deliberately NOT `listUsers` + find: that answers a
   * one-user question by walking the whole directory, and — worse — cannot
   * distinguish "this user is absent" from "the listing was truncated", so a
   * short read would make a confirmed member look revocable.
   */
  getUserById(id: string): Promise<{ data: { user: { id: string; confirmed_at?: string } | null }; error: unknown }>
  deleteUser(id: string): Promise<{ error: unknown }>
}

export interface InviteInput {
  email: string
  name: string
  role: Role
  profession: Profession | null
  /** Absolute URL the invite link lands on. Built from APP_URL by the caller. */
  redirectTo: string
}

export async function inviteMember(
  db: PrismaClient,
  admin: InviteAdminPort,
  input: InviteInput,
): Promise<{ userId: number } | AppError> {
  const email = input.email.trim().toLowerCase()

  const existing = await db.user.findUnique({ where: { email } })
  if (existing?.authUserId) {
    return createAppError('ALREADY_CLAIMED', 'That person already has an account.')
  }

  // Creates the auth user AND sends the email in one call — this is the only
  // way to make Supabase send mail, and the reason Supabase owns identity at
  // all (spec §1).
  const { data, error } = await admin.inviteUserByEmail(email, { redirectTo: input.redirectTo })
  if (error || !data.user) {
    return createAppError('INVALID_INPUT', 'Could not send that invite. Check the address and try again.')
  }
  const authUserId = data.user.id

  // A SECOND call, deliberately: inviteUserByEmail's own `data` option writes
  // user_metadata, which the user can rewrite. Role must live in app_metadata.
  const stamped = await admin.updateUserById(authUserId, {
    app_metadata: { role: input.role, profession: input.profession },
  })
  if (stamped.error) {
    await admin.deleteUser(authUserId)
    return createAppError('INVALID_INPUT', 'Could not complete that invite. Please try again.')
  }

  try {
    const profile = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: {
            authUserId,
            role: input.role,
            profession: input.profession,
            // Clearing this is what makes re-inviting a departed member work.
            // Left set, the invite sends and Supabase accepts it, the invitee
            // sets a password — and then `/auth/confirm`'s roster gate refuses
            // them with "This account is no longer active", because
            // `checkRosterByEmail` still sees `deactivatedAt`. The manager sees
            // a successful invite; the person simply cannot get in.
            //
            // Deliberately NOT restoring their released claims: those shifts
            // belong to whoever picked them up in the meantime.
            deactivatedAt: null,
          },
        })
      : await db.user.create({
          data: { email, name: input.name, role: input.role, profession: input.profession, authUserId },
        })
    return { userId: profile.id }
  } catch {
    // Roll the auth user back. Leaving it would create an account that can
    // authenticate but has no profile — currentSessionUser() returns null for
    // it, so the person signs in successfully and is bounced straight back to
    // /login with nothing explaining why.
    await admin.deleteUser(authUserId)
    return createAppError('INVALID_INPUT', 'Could not link that invite to a roster record.')
  }
}

export async function resendInvite(
  db: PrismaClient,
  admin: InviteAdminPort,
  userId: number,
  redirectTo: string,
): Promise<{ ok: true } | AppError> {
  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile?.authUserId) {
    return createAppError('NOT_FOUND', 'That person has no pending invite.')
  }

  // Verified against the local GoTrue stack (Mailpit), not assumed: a
  // pending (unconfirmed) invite re-sends with 200 and a fresh email — no
  // error at all. `email_exists` is GoTrue's answer only once the person has
  // already accepted, and in that case NO mail goes out. So `email_exists` is
  // not a tolerable "already sent" outcome to fold into `{ ok: true }` — it is
  // the one error worth a distinct message, and every other error is a
  // genuine failure. Do not restore an `email_exists` tolerance here.
  const { error } = await admin.inviteUserByEmail(profile.email, { redirectTo })
  if (error) {
    if ((error as { code?: string }).code === 'email_exists') {
      return createAppError('ALREADY_CLAIMED', 'That person has already accepted their invite.')
    }
    return createAppError('INVALID_INPUT', 'Could not resend that invite.')
  }
  return { ok: true }
}

export async function revokeInvite(
  db: PrismaClient,
  admin: InviteAdminPort,
  userId: number,
): Promise<{ ok: true } | AppError> {
  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile?.authUserId) {
    return createAppError('NOT_FOUND', 'That person has no pending invite.')
  }

  // PENDING invites only. Without this check, `DELETE /api/members/{id}/invite`
  // on somebody who has already accepted deletes their Supabase auth user
  // outright — losing their password and their ability to sign in, from a
  // button that says "revoke invite". The UI only offers it for
  // `status === 'invited'`, but the API is the boundary, and it has to hold on
  // its own: a manager with curl, a stale page, or a future caller all bypass
  // that UI check.
  const { data: looked, error: lookupError } = await admin.getUserById(profile.authUserId)
  if (lookupError) {
    return createAppError('BUSY', 'Could not reach the accounts service. Please try again.')
  }
  if (looked.user?.confirmed_at) {
    return createAppError('ALREADY_CLAIMED', 'That person has already accepted their invite.')
  }
  // `looked.user === null` means the account is already gone from Supabase
  // (deleted out-of-band). Falling through is right: there is nothing left to
  // protect, and the profile still needs its stale `authUserId` cleared below.

  const { error } = await admin.deleteUser(profile.authUserId)
  if (error) return createAppError('INVALID_INPUT', 'Could not revoke that invite.')

  // The roster row survives with authUserId null — the person is still a real
  // staff member who can be re-invited; only the pending account is withdrawn.
  await db.user.update({ where: { id: userId }, data: { authUserId: null } })
  return { ok: true }
}
