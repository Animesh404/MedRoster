import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { getServerEnv } from '@/lib/config/env'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { resendInvite, revokeInvite, type InviteAdminPort } from '@/lib/members/invite'

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

function parseId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export const POST = withAuth('member:invite', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const userId = parseId((await ctx.params).id)
  if (userId === null) return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))

  const result = await resendInvite(
    prisma, adminPort(), userId, `${getServerEnv().appUrl}/auth/accept-invite`,
  )
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})

export const DELETE = withAuth('member:manage', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const userId = parseId((await ctx.params).id)
  if (userId === null) return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))

  const result = await revokeInvite(prisma, adminPort(), userId)
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
