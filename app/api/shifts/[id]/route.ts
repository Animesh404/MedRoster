import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { updateShiftSchema } from '@/lib/contracts/shifts'
import { createAppError } from '@/lib/domain/errors'
import { resolveShiftWindow } from '@/lib/domain/time'
import {
  commitShiftDelete, commitShiftEdit, previewShiftDelete, previewShiftEdit,
} from '@/lib/rules/edit'

const parseId = (raw: string) => (Number.isInteger(Number(raw)) ? Number(raw) : null)

export const GET = withAuth('shift:read', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      requirements: true,
      claims: { include: { user: { select: { id: true, name: true, profession: true } } } },
    },
  })
  if (!shift) return errorResponse(createAppError('NOT_FOUND', 'That shift no longer exists.'))
  return NextResponse.json(shift)
})

export const PATCH = withAuth('shift:update', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const parsed = updateShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const { date, startTime, endTime, requirements, expectedVersion, claimsToken, mutationId } = parsed.data
  const { startsAt, endsAt } = resolveShiftWindow(date, startTime, endTime)
  const proposed = { startsAt, endsAt, requirements }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const result = dryRun
    ? await previewShiftEdit(prisma, shiftId, proposed)
    : await commitShiftEdit(
        prisma, shiftId, proposed,
        { version: expectedVersion, claimsToken },
        mutationId,
      )

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})

export const DELETE = withAuth('shift:delete', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const url = new URL(req.url)
  if (url.searchParams.get('dryRun') === '1') {
    const preview = await previewShiftDelete(prisma, shiftId)
    if ('code' in preview) return errorResponse(preview)
    return NextResponse.json(preview)
  }

  const expectedVersion = Number(url.searchParams.get('expectedVersion'))
  const claimsToken = url.searchParams.get('claimsToken')
  if (!Number.isInteger(expectedVersion) || !claimsToken) {
    return errorResponse(createAppError('INVALID_INPUT', 'expectedVersion and claimsToken are required.'))
  }

  const result = await commitShiftDelete(
    prisma, shiftId, { version: expectedVersion, claimsToken },
    url.searchParams.get('mutationId') ?? undefined,
  )
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
