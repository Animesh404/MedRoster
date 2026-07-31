import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { reactivateMember, type BanAdminPort } from '@/lib/members/deactivate'

function banPort(): BanAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    updateUserById: async (id, attrs) => {
      const { error } = await admin.updateUserById(id, attrs)
      return { error }
    },
  }
}

/**
 * Undoes a deactivation. `member:manage`, the same permission that performed
 * it — whoever can offboard someone can bring them back.
 *
 * A sub-resource POST rather than a PATCH on the member: it is an action with
 * no payload, and it mirrors the existing `[id]/invite` shape.
 */
export const POST = withAuth('member:manage', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const { id } = await ctx.params
  const userId = Number(id)
  if (!Number.isInteger(userId) || userId <= 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))
  }

  const result = await reactivateMember(prisma, banPort(), userId)
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
