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

  const rows = await prisma.eventOutbox.findMany({
    where: { topic: parsed.data.topic, id: { gt: BigInt(parsed.data.id) } },
    orderBy: { id: 'asc' },
    take: parsed.data.limit,
  })

  // Read AFTER the rows, deliberately. These are two separate reads under READ
  // COMMITTED, so a prune committing between them matters — and this ordering
  // makes the race fail safe. Because the delete and the watermark advance
  // commit together, any row already gone at row-read time has its advance
  // committed too, so this later read must see it. The reverse order could
  // read a stale-low watermark and an already-pruned (empty) page, and report
  // `cursorLost: false` — exactly the silent-loss case this exists to prevent.
  // Worst case here is a needless resync, which is the right direction to err.
  const watermark = await prunedWatermark(prisma)
  const cursorLost = BigInt(parsed.data.id) < watermark

  return NextResponse.json({
    events: rows.map((e) => ({
      id: e.id.toString(), type: e.type,
      payload: e.payload, mutationId: e.mutationId,
      createdAt: e.createdAt.toISOString(),
    })),
    /**
     * Where the client should resume.
     *
     * When the cursor is lost and the topic has NO surviving rows, this must
     * advance to the watermark rather than echoing the client's own cursor
     * back. Echoing it leaves the client below the watermark, so the next poll
     * reports lost again — a resync every few seconds, forever, on every quiet
     * topic. Advancing to the watermark loses nothing: everything at or below
     * it is provably deleted, and the client has already been told to refetch.
     */
    lastId: rows.length > 0
      ? rows[rows.length - 1]!.id.toString()
      : (cursorLost ? watermark.toString() : parsed.data.id),
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
