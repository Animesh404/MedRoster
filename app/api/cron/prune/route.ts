import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withCronAuth } from '@/lib/auth/with-cron-auth'
import { pruneMutationOutcomes } from '@/lib/rules/retention'

async function prune(): Promise<Response> {
  const outcomes = await pruneMutationOutcomes(prisma)

  // `pruneEventOutbox` is deliberately NOT called here, and the reason is not
  // that it is unfinished — it works, and the lost-cursor signal that makes it
  // safe for polling clients is live.
  //
  // EventOutbox is not only a replay log. It is the SOLE store behind
  // /my-shifts' drop notices — which that page's own comment calls "the one
  // thing a staff member cannot be left to discover only by noticing a shift
  // missing on the day" — and behind the shift-detail activity timeline.
  // Deleting a row there deletes a notice a nurse may not have seen yet: a
  // shift four weeks out, dropped today, would lose its banner while the shift
  // is still ahead of them, and somebody who does not log in for a week would
  // never learn at all.
  //
  // That needs those notices to have a durable home of their own before any
  // event is deleted. See docs/KNOWN_ISSUES.md.
  const deleted = outcomes.deleted
  const exhausted = outcomes.exhausted

  // `exhausted` is the only interesting thing this job has to say: it means the
  // run hit its batch ceiling with work still left, i.e. the table is growing
  // faster than one nightly run can clear it. A bare count cannot express that
  // — "10,000 deleted" reads identically whether that drained the backlog or
  // merely dented it.
  if (exhausted) {
    console.warn(
      `cron/prune: hit the batch ceiling after ${deleted} rows — backlog remains ` +
      `(mutation outcomes)`,
    )
  } else {
    console.info(`cron/prune: deleted ${outcomes.deleted} expired mutation outcomes`)
  }

  return NextResponse.json({ deleted, exhausted, mutationOutcomes: outcomes.deleted })
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
