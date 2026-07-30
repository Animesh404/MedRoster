import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { getServerEnv } from '@/lib/config/env'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { inviteMemberSchema } from '@/lib/contracts/members'
import { inviteMember, type InviteAdminPort } from '@/lib/members/invite'
import { memberStatus } from '@/lib/members/status'

/**
 * Adapts supabase-js's admin API to the narrow ports the member services take.
 * Written out rather than cast: supabase-js's own return types are wider than
 * the ports and will not assign structurally, and an `as unknown as` would
 * survive a breaking change in the library silently.
 */
function adminPort(): InviteAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    inviteUserByEmail: async (email, options) => {
      const { data, error } = await admin.inviteUserByEmail(email, options)
      return { data: { user: data?.user ?? null }, error }
    },
    updateUserById: async (id, attrs) => {
      const { data, error } = await admin.updateUserById(id, attrs)
      return { data: { user: data?.user ?? null }, error }
    },
    listUsers: async () => {
      const { data, error } = await admin.listUsers({ perPage: 1000 })
      return { data: { users: data?.users ?? [] }, error }
    },
    deleteUser: async (id) => {
      const { error } = await admin.deleteUser(id)
      return { error }
    },
  }
}

export const GET = withAuth('member:read', async () => {
  const profiles = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, email: true, role: true, profession: true,
      authUserId: true, deactivatedAt: true,
    },
  })

  // One admin call joined in memory, rather than a stored status column that
  // would drift from Supabase the moment anyone touched the dashboard (§3.1).
  //
  // A FAILED call is not the same as "nobody has an account": swallowing the
  // error would render every member — including all four demo accounts — as
  // "No account", which is 35 rows of confident misinformation. Per-user
  // absence still degrades to no-account (see memberStatus); a whole-call
  // failure is an error.
  const { data, error } = await adminPort().listUsers()
  if (error) {
    return errorResponse(createAppError('BUSY', 'Could not reach the accounts service. Please try again.'))
  }
  const byId = new Map(data.users.map((u) => [u.id, u]))

  const members = profiles.map((p) => {
    const authUser = p.authUserId ? byId.get(p.authUserId) : undefined
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      profession: p.profession,
      status: memberStatus({
        authUserId: p.authUserId,
        deactivatedAt: p.deactivatedAt,
        authUser: authUser
          ? { confirmedAt: authUser.confirmed_at ? new Date(authUser.confirmed_at) : null }
          : null,
      }),
    }
  })

  return NextResponse.json({ members })
})

export const POST = withAuth('member:invite', async (req) => {
  const raw: unknown = await req.json().catch(() => null)
  const parsed = inviteMemberSchema.safeParse(raw)
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const result = await inviteMember(prisma, adminPort(), {
    ...parsed.data,
    redirectTo: `${getServerEnv().appUrl}/auth/accept-invite`,
  })
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
