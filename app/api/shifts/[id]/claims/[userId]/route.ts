import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { can, scopedPermission } from '@/lib/auth/permissions'
import { createAppError } from '@/lib/domain/errors'
import { unassignClaim } from '@/lib/rules/assign'

export const DELETE = withAuth('claim:delete:self', async (req: Request, ctx: AuthedContext<{ id: string; userId: string }>) => {
  const { id, userId } = await ctx.params
  const shiftId = Number(id)
  const targetUserId = Number(userId)
  if (!Number.isInteger(shiftId) || !Number.isInteger(targetUserId)) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad shift or user id.'))
  }

  const required = scopedPermission(ctx.principal, 'claim:delete', targetUserId)
  if (!can(ctx.principal, required)) {
    return errorResponse(createAppError('FORBIDDEN', 'You can only release your own shifts.'))
  }

  const mutationId = new URL(req.url).searchParams.get('mutationId') ?? undefined
  const result = await unassignClaim({
    db: prisma, shiftId, userId: targetUserId,
    ...(mutationId !== undefined ? { mutationId } : {}),
  })

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
