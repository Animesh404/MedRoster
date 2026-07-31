import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { pruneMutationOutcomes } from '@/lib/rules/retention'

/**
 * Scheduled cleanup of expired idempotency records.
 *
 * NOT wrapped in `withAuth`, and deliberately so: there is no MedRoster session
 * behind a cron invocation. `tests/rbac/routes.test.ts` therefore has an
 * explicit exemption for this path — see the note there. The guard is the
 * shared secret below instead.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on scheduled
 * invocations. Without the secret set, the route refuses everything rather than
 * running open: a cleanup endpoint anyone can trigger is a small denial-of-
 * service lever, and the failure mode of refusing is a table that grows, which
 * is visible and recoverable.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.warn('cron/prune: CRON_SECRET is not set — refusing to run')
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Scheduled tasks are not configured.' } },
      { status: 403 },
    )
  }

  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Not authorised.' } },
      { status: 403 },
    )
  }

  const deleted = await pruneMutationOutcomes(prisma)

  // Logged, not silent: a count that keeps arriving at the batch ceiling means
  // the table is growing faster than one run can clear it, which is the only
  // interesting thing this job has to say.
  console.info(`cron/prune: deleted ${deleted} expired mutation outcomes`)

  return NextResponse.json({ deleted })
}
