import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { can, scopedPermission } from '@/lib/auth/permissions'
import { createClaimSchema } from '@/lib/contracts/claims'
import { createAppError } from '@/lib/domain/errors'
import { assignClaim } from '@/lib/rules/assign'

export const POST = withAuth('claim:create:self', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const { id } = await ctx.params
  const shiftId = Number(id)
  if (!Number.isInteger(shiftId)) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))
  }

  const parsed = createClaimSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const targetUserId = parsed.data.userId ?? ctx.principal.id

  // Claiming for somebody else is a strictly stronger permission than for
  // self — a staff member has claim:create:self but not claim:create:any,
  // so scopedPermission resolving to :any for a foreign targetUserId is what
  // actually keeps them from assigning anyone but themselves.
  const required = scopedPermission(ctx.principal, 'claim:create', targetUserId)
  if (!can(ctx.principal, required)) {
    return errorResponse(createAppError('FORBIDDEN', 'You can only claim shifts for yourself.'))
  }

  const result = await assignClaim({
    db: prisma, shiftId, userId: targetUserId,
    actorId: ctx.principal.id,
    ...(parsed.data.mutationId !== undefined ? { mutationId: parsed.data.mutationId } : {}),
  })

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result, { status: 201 })
})
