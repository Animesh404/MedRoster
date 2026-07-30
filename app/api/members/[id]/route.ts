import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { deactivateMember, type BanAdminPort } from '@/lib/members/deactivate'

function banPort(): BanAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    updateUserById: async (id, attrs) => {
      const { error } = await admin.updateUserById(id, attrs)
      return { error }
    },
  }
}

export const DELETE = withAuth('member:manage', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const { id } = await ctx.params
  const userId = Number(id)
  if (!Number.isInteger(userId) || userId <= 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))
  }

  // A manager who deactivates themselves would be locked out of the only page
  // that could undo it, with no other manager necessarily existing.
  if (userId === ctx.principal.id) {
    return errorResponse(createAppError('FORBIDDEN', 'You cannot deactivate your own account.'))
  }

  const result = await deactivateMember(prisma, banPort(), userId)
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
