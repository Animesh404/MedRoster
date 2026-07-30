import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { prisma } from '@/lib/db/client'
import { checkRosterByEmail } from '@/lib/auth/roster-gate'
import { safeNextPath } from '@/lib/auth/safe-redirect'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Turns an emailed link into a cookie session the server can read.
 *
 * Measured, not assumed: GoTrue's default `{{ .ConfirmationURL }}` points at
 * its own `/verify`, which answers `303` with the tokens in the URL
 * **fragment** (`#access_token=…`). Fragments never reach the server, so a
 * Server Component reading `getUser()` would see nothing and reject every
 * valid link. Our templates therefore send `{{ .TokenHash }}` to this route,
 * which exchanges it with `verifyOtp` and sets the cookie before redirecting.
 *
 * The roster gate runs here too. A link is evidence that someone controls an
 * inbox, not that they are still a member — an invite sent last week to
 * somebody since deactivated must not become a session.
 */
const ALLOWED_TYPES = new Set<EmailOtpType>(['invite', 'recovery', 'magiclink', 'email', 'email_change'])

function isAllowedType(value: string | null): value is EmailOtpType {
  return value !== null && ALLOWED_TYPES.has(value as EmailOtpType)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  // Same confinement as the login action's `next` (lib/auth/safe-redirect.ts):
  // this route is publicly reachable and the parameter is attacker-supplied in
  // a crafted link, so it must never become an off-origin redirect.
  const next = safeNextPath(url.searchParams.get('next'))

  const deny = (reason: string) => {
    const target = new URL('/login', url.origin)
    target.searchParams.set('error', reason)
    return NextResponse.redirect(target)
  }

  if (!tokenHash || !isAllowedType(type)) {
    return deny('That link is not valid. Please request a new one.')
  }

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
  if (error || !data.user?.email) {
    return deny('That link has expired or has already been used. Please request a new one.')
  }

  const profile = await prisma.user.findUnique({
    where: { email: data.user.email.toLowerCase() },
    select: { deactivatedAt: true, authUserId: true },
  })

  // An invite link is the one case where the profile legitimately has no
  // authUserId yet at gate time — inviteMember links it, so by the time the
  // link is clicked it is set. If it is genuinely absent the invite was
  // revoked, and refusing is correct.
  const gate = checkRosterByEmail(profile)
  if (!gate.allowed) {
    await supabase.auth.signOut()
    return deny(gate.reason)
  }

  return NextResponse.redirect(new URL(next, url.origin))
}
