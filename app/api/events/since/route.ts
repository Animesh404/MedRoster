import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { eventsSinceQuerySchema } from '@/lib/contracts/events'

/**
 * Replay for reconnecting clients (§7.1). Supabase Realtime broadcast is
 * at-most-once with no history, so a client that slept or dropped its socket
 * fetches the gap here rather than silently missing updates.
 */
export const GET = withAuth('shift:read', async (req) => {
  const url = new URL(req.url)
  const parsed = eventsSinceQuerySchema.safeParse({
    id: url.searchParams.get('id') ?? undefined,
    topic: url.searchParams.get('topic') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const rows = await prisma.eventOutbox.findMany({
    where: { topic: parsed.data.topic, id: { gt: BigInt(parsed.data.id) } },
    orderBy: { id: 'asc' },
    take: parsed.data.limit,
  })

  return NextResponse.json({
    events: rows.map((e) => ({
      id: e.id.toString(), type: e.type,
      payload: e.payload, mutationId: e.mutationId,
    })),
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id.toString() : parsed.data.id,
    /** True when the page was capped — the client should resync rather than assume it caught up. */
    truncated: rows.length === parsed.data.limit,
  })
})
