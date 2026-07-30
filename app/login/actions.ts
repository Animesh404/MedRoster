'use server'

import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db/client'
import { checkRoster } from '@/lib/auth/roster-gate'
import { safeNextPath } from '@/lib/auth/safe-redirect'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export interface LoginState {
  error: string | null
}

/**
 * Server Action behind the login form.
 *
 * `redirect()` throws a Next.js control-flow signal rather than returning, so
 * it must sit outside any try/catch that would swallow it — hence the explicit
 * error returns above it instead of a wrapping try.
 *
 * The roster check after a successful password check is not redundant: a
 * Supabase user can exist without a MedRoster profile (a stale account, or one
 * created out-of-band), and `currentSessionUser()` returns null for those. Left
 * unchecked, such a user would sign in "successfully" and then be bounced
 * straight back to /login by the app layout with nothing explaining why.
 */
export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '').trim()

  if (!email || !password) {
    return { error: 'Enter both an email and a password.' }
  }

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data.user) {
    return { error: 'Incorrect email or password.' }
  }

  const profile = await prisma.user.findUnique({ where: { authUserId: data.user.id } })
  const gate = checkRoster(profile)
  if (!gate.allowed) {
    await supabase.auth.signOut()
    return { error: gate.reason }
  }

  redirect(safeNextPath(next))
}
