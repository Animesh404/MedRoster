import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema, parseDbId } from '@/lib/contracts/common'

const OUTCOMES = ['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED'] as const

export const GET = withAuth('import:read', async (req: Request, ctx: AuthedContext<{ runId: string }>) => {
  const runId = parseDbId((await ctx.params).runId)
  if (runId === null) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad run id.'))
  }

  const run = await prisma.importRun.findUnique({
    where: { id: runId },
    select: {
      id: true, source: true, fileKind: true, filename: true,
      stats: true, createdAt: true, actor: { select: { name: true } },
    },
  })
  if (!run) return errorResponse(createAppError('NOT_FOUND', 'No such import run.'))

  const url = new URL(req.url)
  // .safeParse, not .parse (IMP-3): see app/api/shifts/route.ts for the
  // full rationale — an ordinary bad `?limit=` must 400, not 500.
  const parsedQuery = pageQuerySchema.safeParse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsedQuery.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsedQuery.error.issues[0]!.message))
  }
  const { cursor, limit } = parsedQuery.data
  const outcome = url.searchParams.get('outcome')

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.importRowResult.findMany({
      ...args,
      where: {
        importRunId: runId,
        // Fail safe on an unrecognised outcome value (IMP-5): an unknown
        // string falls through to "no filter" rather than being coerced
        // into a Prisma enum it can't represent.
        ...(outcome && (OUTCOMES as readonly string[]).includes(outcome)
          ? { outcome: outcome as (typeof OUTCOMES)[number] } : {}),
      },
      select: { id: true, rowNumber: true, rawRow: true, outcome: true, issues: true },
    }),
  })

  return NextResponse.json({ run, ...page })
})
