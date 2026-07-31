import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withCronAuth } from '@/lib/auth/with-cron-auth'
import { pruneDropNotices, pruneEventOutbox, pruneMutationOutcomes } from '@/lib/rules/retention'

async function prune(): Promise<Response> {
  const outcomes = await pruneMutationOutcomes(prisma)
  const notices = await pruneDropNotices(prisma)
  const outbox = await pruneEventOutbox(prisma)

  // `pruneEventOutbox` is wired in as of 2026-07-31, at a deliberate 10-day
  // window. It was held back for a long time, and the two things that had to be
  // true first are now both true:
  //
  //  1. **A stranded cursor is detectable.** The delete and the `OutboxWatermark`
  //     advance commit in ONE transaction, so a client polling `id > lastId` for
  //     rows that are gone is told `cursorLost` and resyncs, rather than getting
  //     an empty page and concluding it is up to date.
  //  2. **Drop notices no longer live here.** They have their own durable table,
  //     written in the same transaction as the drop. Deleting an event used to
  //     delete a notice a nurse may never have seen — the severe harm, and the
  //     real reason this stayed unwired.
  //
  // What pruning still costs is the shift-detail activity timeline, which
  // renders from these rows: history older than the window stops being visible.
  // That is a truncation, not a corruption — current claims keep showing
  // correctly — and 10 days is the answer to how much to keep.
  const deleted = outcomes.deleted + notices.deleted + outbox.deleted
  const exhausted = outcomes.exhausted || notices.exhausted || outbox.exhausted

  // `exhausted` is the only interesting thing this job has to say: it means the
  // run hit its batch ceiling with work still left, i.e. a table is growing
  // faster than one nightly run can clear it. A bare count cannot express that
  // — "10,000 deleted" reads identically whether that drained the backlog or
  // merely dented it.
  if (exhausted) {
    console.warn(
      `cron/prune: hit the batch ceiling after ${deleted} rows — backlog remains ` +
      `(mutation outcomes: ${outcomes.deleted}${outcomes.exhausted ? ', capped' : ''}; ` +
      `drop notices: ${notices.deleted}${notices.exhausted ? ', capped' : ''}; ` +
      `outbox events: ${outbox.deleted}${outbox.exhausted ? ', capped' : ''})`,
    )
  } else {
    console.info(
      `cron/prune: deleted ${outcomes.deleted} expired mutation outcomes, ` +
      `${notices.deleted} expired drop notices and ${outbox.deleted} expired outbox events`,
    )
  }

  return NextResponse.json({
    deleted, exhausted,
    mutationOutcomes: outcomes.deleted,
    dropNotices: notices.deleted,
    outboxEvents: outbox.deleted,
  })
}

/**
 * Scheduled cleanup of expired idempotency records, drop notices and outbox events.
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
