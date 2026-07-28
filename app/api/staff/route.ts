import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'

export const GET = withAuth('staff:read', async (req) => {
  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.user.findMany({
      ...args,
      where: { role: 'STAFF' },
      select: { id: true, name: true, email: true, profession: true },
    }),
  })

  return NextResponse.json(page)
})
