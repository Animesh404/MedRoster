import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { checkRosterByEmail } from '@/lib/auth/roster-gate'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

/**
 * Layer 3 of the roster gate (spec §5.4).
 *
 * Layer 1 is the dashboard's "allow new users to sign up" toggle, which gates
 * OAuth only. Layer 2 is `shouldCreateUser: false` on magic link, which gates
 * that path only — verified against GoTrue's source, `otp.go` never consults
 * DisableSignup at all. Neither knows anything about MedRoster's own roster, so
 * this layer is the one that asks the question that actually matters: is this
 * person a member?
 *
 * It also catches what the other two cannot — a member deactivated after their
 * account was created, and any auth user that exists without a profile.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')

  const deny = (reason: string) => {
    const target = new URL('/login', url.origin)
    target.searchParams.set('error', reason)
    return NextResponse.redirect(target)
  }

  if (!code) return deny('That sign-in link is not valid. Please try again.')

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)
  if (error || !data.user?.email) {
    return deny('That sign-in link has expired. Please request a new one.')
  }

  const profile = await prisma.user.findUnique({
    where: { email: data.user.email.toLowerCase() },
    select: { deactivatedAt: true, authUserId: true },
  })

  const gate = checkRosterByEmail(profile)
  if (!gate.allowed) {
    await supabase.auth.signOut()

    // Delete the account OAuth just minted whenever the refusal was
    // "not a member" — both when there is no profile at all, and when there is
    // a profile that was never invited (an imported staff.csv row).
    //
    // The second case is the one that is easy to miss and expensive to get
    // wrong: leaving that auth user alive permanently bricks the address.
    // `inviteMember` checks `existing?.authUserId`, which is still null, so it
    // proceeds to `inviteUserByEmail`, receives `email_exists`, and fails — for
    // every future attempt, until somebody deletes the stray account by hand.
    //
    // A DEACTIVATED member is deliberately excluded: their account is banned
    // and audited, and deleting it would discard that record and let them be
    // silently re-invited as though new.
    if (!profile || !profile.authUserId) {
      await createSupabaseAdminClient().auth.admin.deleteUser(data.user.id)
    }

    return deny(gate.reason)
  }

  return NextResponse.redirect(new URL('/dashboard', url.origin))
}
