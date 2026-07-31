import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withCronAuth } from '@/lib/auth/with-cron-auth'
import { pruneDropNotices, pruneMutationOutcomes } from '@/lib/rules/retention'

async function prune(): Promise<Response> {
  const outcomes = await pruneMutationOutcomes(prisma)
  const notices = await pruneDropNotices(prisma)

  // `pruneEventOutbox` is still deliberately NOT called here, but the reason
  // has changed and is now narrower.
  //
  // It used to be that EventOutbox was the SOLE store behind /my-shifts' drop
  // notices, so deleting a row deleted a notice a nurse might never have seen.
  // The `DropNotice` table closed that: every drop path now writes a durable,
  // per-member row, and the page reads it instead of reconstructing anything
  // from events.
  //
  // What remains is the shift-detail activity timeline, which still renders
  // straight from EventOutbox. Pruning at OUTBOX_RETENTION_MS would silently
  // truncate that history to seven days. Losing it is a far smaller harm than
  // losing a drop notice — it is a record, not a notification — but it is a
  // deliberate product decision rather than a cleanup detail, so it stays
  // unwired until somebody decides how much timeline to keep.
  // See docs/KNOWN_ISSUES.md.
  const deleted = outcomes.deleted + notices.deleted
  const exhausted = outcomes.exhausted || notices.exhausted

  // `exhausted` is the only interesting thing this job has to say: it means the
  // run hit its batch ceiling with work still left, i.e. a table is growing
  // faster than one nightly run can clear it. A bare count cannot express that
  // — "10,000 deleted" reads identically whether that drained the backlog or
  // merely dented it.
  if (exhausted) {
    console.warn(
      `cron/prune: hit the batch ceiling after ${deleted} rows — backlog remains ` +
      `(mutation outcomes: ${outcomes.deleted}${outcomes.exhausted ? ', capped' : ''}; ` +
      `drop notices: ${notices.deleted}${notices.exhausted ? ', capped' : ''})`,
    )
  } else {
    console.info(
      `cron/prune: deleted ${outcomes.deleted} expired mutation outcomes ` +
      `and ${notices.deleted} expired drop notices`,
    )
  }

  return NextResponse.json({
    deleted, exhausted,
    mutationOutcomes: outcomes.deleted,
    dropNotices: notices.deleted,
  })
}

/**
 * Scheduled cleanup of expired idempotency records and drop notices.
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
