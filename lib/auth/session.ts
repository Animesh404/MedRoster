import { cache } from 'react'
import { prisma } from '@/lib/db/client'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import type { Principal } from './permissions'

export interface SessionUser {
  /** Supabase auth.users.id. */
  authUserId: string
  email: string
  name: string
  principal: Principal
}

/**
 * The one place a Supabase session becomes a MedRoster `Principal`.
 *
 * `getUser()` rather than `getSession()`: `getSession()` decodes the cookie
 * without asking the auth server whether it is still valid, so a revoked or
 * banned user would keep passing. `getUser()` revalidates. §Global Constraints
 *
 * Role and profession come from the profile row, never from the token's
 * `app_metadata`. A token lives up to an hour, so a manager demoted a minute
 * ago still carries `role: MANAGER` in their claims — authorizing from that
 * would hand them an hour of access they no longer have. §2 of the spec.
 *
 * `cache()` dedupes within a single request: the layout, the page and a route
 * handler all asking for the session cost one auth call and one query.
 */
export const currentSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null

  const profile = await prisma.user.findUnique({ where: { authUserId: data.user.id } })

  // No profile: an auth user exists that this application does not know about.
  // Deactivated: offboarded, and the ban may not have propagated. Both are
  // "not a member", and both must fail closed.
  if (!profile || profile.deactivatedAt) return null

  return {
    authUserId: data.user.id,
    email: profile.email,
    name: profile.name,
    principal: { id: profile.id, role: profile.role, profession: profile.profession },
  }
})
