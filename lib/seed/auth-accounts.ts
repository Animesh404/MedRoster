import type { PrismaClient } from '@prisma/client'
import { DEMO_ACCOUNTS } from '@/app/login/demo-accounts'

/**
 * The slice of `supabase.auth.admin` this module uses.
 *
 * Narrowed to a port rather than taking a SupabaseClient so the seed logic —
 * idempotency, adoption of pre-existing users, profile linking — is testable
 * against an in-memory fake. Booting a real Supabase stack to assert "running
 * it twice creates four users, not eight" would be a slow way to test
 * arithmetic.
 */
export interface AuthAdminPort {
  listUsers(): Promise<{ data: { users: { id: string; email?: string }[] }; error: unknown }>
  createUser(attrs: {
    email: string
    password: string
    email_confirm: boolean
    app_metadata: Record<string, unknown>
  }): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  updateUserById(
    id: string,
    attrs: { password?: string; app_metadata?: Record<string, unknown> },
  ): Promise<{ data: { user: { id: string } | null }; error: unknown }>
}

export interface EnsureAuthAccountsResult {
  created: number
  updated: number
}

/**
 * Gives the four demo accounts a real Supabase login, and nobody else.
 *
 * The other ~30 staff the CSV import creates are deliberately left without
 * accounts: a spreadsheet row was never a login, and leaving them
 * account-less is what gives the members page (Plan 2) real people to invite.
 *
 * `email_confirm: true` because these are seeded, not invited — there is no
 * inbox to check, and an unconfirmed user cannot sign in with a password.
 *
 * Idempotent by necessity: `docker compose up` runs the seed on every boot.
 */
export async function ensureAuthAccounts(
  db: PrismaClient,
  admin: AuthAdminPort,
  opts: { password: string },
): Promise<EnsureAuthAccountsResult> {
  const { data: existing } = await admin.listUsers()
  const byEmail = new Map(
    existing.users
      .filter((u): u is { id: string; email: string } => typeof u.email === 'string')
      .map((u) => [u.email.toLowerCase(), u.id]),
  )

  let created = 0
  let updated = 0

  for (const account of DEMO_ACCOUNTS) {
    const email = account.email.toLowerCase()
    const profile = await db.user.findUnique({ where: { email } })
    if (!profile) continue

    const appMetadata = { role: profile.role, profession: profile.profession }
    let authUserId = byEmail.get(email)

    if (authUserId) {
      // Adopt: the stack already knows this address (a re-seed, or a database
      // reset against a still-running Supabase). Re-assert the password and
      // metadata so the README credentials keep working either way.
      await admin.updateUserById(authUserId, { password: opts.password, app_metadata: appMetadata })
      updated += 1
    } else {
      const { data, error } = await admin.createUser({
        email,
        password: opts.password,
        email_confirm: true,
        app_metadata: appMetadata,
      })
      if (error || !data.user) {
        // Lost a race, or the address exists but did not come back from
        // listUsers. Re-read and adopt rather than failing the whole seed.
        const { data: refreshed } = await admin.listUsers()
        const found = refreshed.users.find((u) => u.email?.toLowerCase() === email)
        if (!found) throw new Error(`Could not create or find a Supabase user for ${email}`)
        authUserId = found.id
        await admin.updateUserById(authUserId, { password: opts.password, app_metadata: appMetadata })
        updated += 1
      } else {
        authUserId = data.user.id
        created += 1
      }
    }

    await db.user.update({ where: { id: profile.id }, data: { authUserId } })
  }

  return { created, updated }
}
