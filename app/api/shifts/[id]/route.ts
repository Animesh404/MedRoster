import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { parseDbId } from '@/lib/contracts/common'
import { editPreviewSchema, deletePreviewSchema, shiftDetailSchema, updateShiftSchema } from '@/lib/contracts/shifts'
import { createAppError } from '@/lib/domain/errors'
import { resolveShiftWindow } from '@/lib/domain/time'
import {
  commitShiftDelete, commitShiftEdit, previewShiftDelete, previewShiftEdit,
} from '@/lib/rules/edit'

/**
 * Parses `?dryRun=`, failing SAFE on anything unrecognised (IMP-5).
 *
 * `=== '1'` alone means `?dryRun=true`, `?dryRun=yes`, and a bare `?dryRun`
 * all fell through to the DESTRUCTIVE branch — a client typo picked the
 * irreversible path. `'1'`/`'true'` are preview; absent/`'0'`/`'false'` are
 * confirm; anything else is rejected outright rather than guessed at.
 */
function parseDryRun(raw: string | null): boolean | null {
  if (raw === null || raw === '0' || raw === 'false') return false
  if (raw === '1' || raw === 'true') return true
  return null
}

export const GET = withAuth('shift:read', async (_req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseDbId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: {
      id: true, startsAt: true, endsAt: true, version: true,
      seriesId: true, detachedFromSeries: true,
      requirements: { select: { id: true, profession: true, requiredCount: true } },
      claims: {
        select: {
          id: true, userId: true, assignedById: true, createdAt: true,
          user: { select: { id: true, name: true, profession: true } },
        },
      },
    },
  })
  if (!shift) return errorResponse(createAppError('NOT_FOUND', 'That shift no longer exists.'))
  // Parsed through the contract schema (MIN-2), not returned as the raw
  // Prisma entity — a future `select` change can widen what Prisma returns
  // without silently widening the wire format too.
  return NextResponse.json(shiftDetailSchema.parse(shift))
})

export const PATCH = withAuth('shift:update', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseDbId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const parsed = updateShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const dryRun = parseDryRun(new URL(req.url).searchParams.get('dryRun'))
  if (dryRun === null) {
    return errorResponse(createAppError('INVALID_INPUT', 'dryRun must be "1", "true", "0", "false", or omitted.'))
  }

  const { date, startTime, endTime, requirements, expectedVersion, claimsToken, mutationId } = parsed.data
  const { startsAt, endsAt } = resolveShiftWindow(date, startTime, endTime)
  const proposed = { startsAt, endsAt, requirements }

  let result
  if (dryRun) {
    result = await previewShiftEdit(prisma, shiftId, proposed)
  } else {
    // The dry-run path never reads these (MIN-4: they're optional on the
    // schema so a client's first preview doesn't have to invent
    // placeholders), but a confirm is meaningless without them.
    if (expectedVersion === undefined || claimsToken === undefined) {
      return errorResponse(createAppError('INVALID_INPUT', 'expectedVersion and claimsToken are required to confirm.'))
    }
    result = await commitShiftEdit(
      prisma, shiftId, proposed,
      { version: expectedVersion, claimsToken },
      mutationId,
    )
  }

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(editPreviewSchema.parse(result))
})

export const DELETE = withAuth('shift:delete', async (req: Request, ctx: AuthedContext<{ id: string }>) => {
  const shiftId = parseDbId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const url = new URL(req.url)
  const dryRun = parseDryRun(url.searchParams.get('dryRun'))
  if (dryRun === null) {
    return errorResponse(createAppError('INVALID_INPUT', 'dryRun must be "1", "true", "0", "false", or omitted.'))
  }

  if (dryRun) {
    const preview = await previewShiftDelete(prisma, shiftId)
    if ('code' in preview) return errorResponse(preview)
    return NextResponse.json(deletePreviewSchema.parse(preview))
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
