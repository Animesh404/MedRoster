import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withCronAuth } from '@/lib/auth/with-cron-auth'
import { pruneEventOutbox, pruneMutationOutcomes } from '@/lib/rules/retention'

async function prune(): Promise<Response> {
  const outcomes = await pruneMutationOutcomes(prisma)
  // Safe ONLY because `pruneEventOutbox` advances `OutboxWatermark` in the same
  // transaction as the delete, and `GET /api/events/since` reports a cursor
  // below it as lost. Without that pair, deleting events silently strands any
  // client that was behind — see docs/KNOWN_ISSUES.md.
  const events = await pruneEventOutbox(prisma)

  const deleted = outcomes.deleted + events.deleted
  const exhausted = outcomes.exhausted || events.exhausted

  // `exhausted` is the only interesting thing this job has to say: it means the
  // run hit its batch ceiling with work still left, i.e. the table is growing
  // faster than one nightly run can clear it. A bare count cannot express that
  // — "10,000 deleted" reads identically whether that drained the backlog or
  // merely dented it.
  if (exhausted) {
    console.warn(
      `cron/prune: hit the batch ceiling after ${deleted} rows — backlog remains ` +
      `(outcomes ${outcomes.deleted}, events ${events.deleted})`,
    )
  } else {
    console.info(
      `cron/prune: deleted ${outcomes.deleted} mutation outcomes and ${events.deleted} outbox events`,
    )
  }

  return NextResponse.json({
    deleted,
    exhausted,
    mutationOutcomes: outcomes.deleted,
    outboxEvents: events.deleted,
  })
}

/**
 * Scheduled cleanup of expired idempotency records.
 *
 * **GET, because that is what Vercel Cron actually sends.** Its schema has no
 * method field: a scheduled invocation is always an HTTP GET to the configured
 * path. An earlier version of this route exported only POST, which would have
 * 405'd every night — with green tests, a working `npm run db:prune`, and the
 * table growing exactly as if the job did not exist. POST is kept as an alias
 * so a human can trigger it by hand with curl.
 *
 * Not `withAuth`: there is no MedRoster session behind a cron call.
 * `tests/rbac/routes.test.ts` carries an explicit exemption, and asserts this
 * file's handlers carry `WITH_CRON_BRAND` instead — a runtime check on the
 * exported function, not a grep for a secret's name.
 */
export const GET = withCronAuth(prune)
export const POST = withCronAuth(prune)
