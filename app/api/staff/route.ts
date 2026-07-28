import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { createAppError } from '@/lib/domain/errors'

export const GET = withAuth('staff:read', async (req) => {
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

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.user.findMany({
      ...args,
      where: { role: 'STAFF' },
      // `staff:read` is a STAFF-level permission and this directory exists
      // to supply name + profession for the assignment UI — it has no
      // business handing every colleague's email address to any signed-in
      // staff member (MIN-6).
      select: { id: true, name: true, profession: true },
    }),
  })

  return NextResponse.json(page)
})
