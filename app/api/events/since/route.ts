import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { prunedWatermark } from '@/lib/rules/retention'
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

  // A cursor below the pruning watermark provably points at events that no
  // longer exist. Without this the client would receive an empty (or partial)
  // page for `id > lastId`, conclude it was CAUGHT UP, and silently miss every
  // change since — which is why pruning the outbox was unsafe before the
  // watermark existed.
  const watermark = await prunedWatermark(prisma)
  const cursorLost = BigInt(parsed.data.id) < watermark

  const rows = await prisma.eventOutbox.findMany({
    where: { topic: parsed.data.topic, id: { gt: BigInt(parsed.data.id) } },
    orderBy: { id: 'asc' },
    take: parsed.data.limit,
  })

  return NextResponse.json({
    events: rows.map((e) => ({
      id: e.id.toString(), type: e.type,
      payload: e.payload, mutationId: e.mutationId,
      createdAt: e.createdAt.toISOString(),
    })),
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id.toString() : parsed.data.id,
    /** True when the page was capped — the client should resync rather than assume it caught up. */
    truncated: rows.length === parsed.data.limit,
    /**
     * True when the cursor points below everything that still exists, so the
     * events between it and the log are gone. Distinct from `truncated`: that
     * means "too much to send at once", this means "what you asked for is
     * unrecoverable". Both call for a resync; only this one is unrecoverable
     * by paging forward.
     */
    cursorLost,
  })
})
