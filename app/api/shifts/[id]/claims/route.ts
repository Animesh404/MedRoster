import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { can, scopedPermission } from '@/lib/auth/permissions'
import { claimResultSchema, createClaimSchema } from '@/lib/contracts/claims'
import { parseDbId } from '@/lib/contracts/common'
import { createAppError } from '@/lib/domain/errors'
import { assignClaim } from '@/lib/rules/assign'

/**
 * Reads a JSON request body, treating a genuinely empty body (content-length
 * 0 — how a plain self-claim is spelled) as `{}`, but returning `null` for
 * anything else that fails to parse (MIN-1). `PATCH /api/shifts/:id` already
 * used `.catch(() => null)`; this route used `.catch(() => ({}))` instead,
 * so a truncated/malformed body silently became "claim for myself" — the
 * two handlers disagreed on what a broken body means.
 */
async function readJsonBody(req: Request): Promise<unknown | null> {
  const raw = await req.text()
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export const POST = withAuth('claim:create:self', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const { id } = await ctx.params
  const shiftId = parseDbId(id)
  if (shiftId === null) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))
  }

  const body = await readJsonBody(req)
  if (body === null) {
    return errorResponse(createAppError('INVALID_INPUT', 'Malformed JSON body.'))
  }

  const parsed = createClaimSchema.safeParse(body)
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
  return NextResponse.json(claimResultSchema.parse(result), { status: 201 })
})
