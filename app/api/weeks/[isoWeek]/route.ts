import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { weekBounds } from '@/lib/domain/time'
import { compressedWeekSchema, encodeWeek, isoWeekParamSchema, type WeekShift, type WeekStaff } from '@/lib/contracts/week'

/**
 * A week is already a bounded window, so this endpoint is deliberately NOT
 * paginated (§6.4). It returns the compressed encoding plus an ETag, so
 * flipping back to an already-seen week costs a 304.
 */
export const GET = withAuth('shift:read', async (req: Request, ctx: AuthedContext<{ isoWeek: string }>) => {
  const { isoWeek } = await ctx.params
  const parsed = isoWeekParamSchema.safeParse(isoWeek)
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', 'Week must look like 2026-W33.'))
  }

  // The regex above only checks shape; `weekBounds` throws on a
  // shape-correct week that doesn't exist for its year (e.g. 2025-W53, a
  // year with only 52 ISO weeks). That throw must not become the uniform
  // 500 withAuth's boundary would otherwise map it to — it's caller error,
  // not a server fault, so it's mapped to INVALID_INPUT here instead.
  let bounds: { start: Date; end: Date }
  try {
    bounds = weekBounds(parsed.data)
  } catch {
    return errorResponse(createAppError('INVALID_INPUT', 'That ISO week does not exist.'))
  }
  const { start, end } = bounds

  const rows = await prisma.shift.findMany({
    where: { startsAt: { gte: start, lt: end } },
    orderBy: { startsAt: 'asc' },
    include: {
      requirements: true,
      claims: { include: { user: { select: { id: true, name: true, profession: true } } } },
    },
  })

  const staffById = new Map<number, WeekStaff>()
  const shifts: WeekShift[] = rows.map((shift) => {
    const requirements = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
    for (const r of shift.requirements) requirements[r.profession] = r.requiredCount

    const claimantIds: number[] = []
    for (const claim of shift.claims) {
      if (!claim.user.profession) continue
      staffById.set(claim.user.id, {
        id: claim.user.id, name: claim.user.name, profession: claim.user.profession,
      })
      claimantIds.push(claim.user.id)
    }

    return {
      id: shift.id, version: shift.version,
      startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
      requirements, claimantIds,
    }
  })

  // Parsed through the contract schema (MIN-2), not serialised straight from
  // whatever `encodeWeek` happened to build — the same discipline the shift
  // detail route applies to its response.
  const body = compressedWeekSchema.parse(
    encodeWeek({ isoWeek: parsed.data, staff: [...staffById.values()], shifts }),
  )
  const payload = JSON.stringify(body)
  const etag = `W/"${createHash('sha1').update(payload).digest('base64url')}"`

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  return new NextResponse(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'private, no-cache' },
  })
})
