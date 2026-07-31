import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { dismissDropNotice } from '@/lib/rules/drop-notice'

/**
 * Acknowledges one of the caller's own drop notices.
 *
 * Guarded by `claim:read`-adjacent reasoning rather than a new permission: every
 * signed-in member has notices, and the only authorization question is whose.
 * That is answered by scoping the write to `principal.id` — never to an id from
 * the request — so `shift:read`, which every role holds, is the right gate.
 */
export const DELETE = withAuth('shift:read', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const { id } = await ctx.params
  const noticeId = Number(id)
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid notice id.'))
  }

  // `ctx.principal.id`, not anything from the request body or query — a client
  // supplying its own user id here would be able to clear anyone's notices.
  const result = await dismissDropNotice(prisma, ctx.principal.id, noticeId)
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
