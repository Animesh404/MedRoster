import { NextResponse } from 'next/server'
import { withRetry } from '@/lib/rules/retry'

/**
 * Non-enumerable brand stamped on every handler this produces.
 *
 * Exists for the same reason `WITH_AUTH_BRAND` does: `tests/rbac/routes.test.ts`
 * must be able to assert something it cannot be fooled about. A scheduled route
 * has no session, so it cannot go through `withAuth` — but "exempt from
 * `withAuth`" must not degrade into "checked by grepping the source for a
 * secret's name", which a comment satisfies. The exemption names this brand,
 * and the test asserts it on the real exported function object.
 */
export const WITH_CRON_BRAND = Symbol('withCronAuth.brand')

/**
 * Wraps a scheduled-task handler with a shared-secret check.
 *
 * Refuses when `CRON_SECRET` is unset rather than running open: this endpoint
 * mutates data, and an unconfigured deployment should fail visibly (a job that
 * never runs, and a table that grows) rather than silently exposing a lever
 * anyone can pull.
 *
 * Retries and error handling mirror what `withAuth` gives every other route —
 * losing them was a real cost of the exemption, not a technicality.
 */
export function withCronAuth(handler: () => Promise<Response>) {
  const wrapped = async (req: Request): Promise<Response> => {
    const secret = process.env.CRON_SECRET
    if (!secret) {
      console.warn('withCronAuth: CRON_SECRET is not set — refusing to run')
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

    try {
      // Same retry the claim path gets: two overlapping runs can collide on row
      // locks (40P01), and a burst can exhaust the shared pool (P2024).
      return await withRetry(() => handler())
    } catch (err) {
      console.error('Unhandled error in scheduled task', err)
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } },
        { status: 500 },
      )
    }
  }

  Object.defineProperty(wrapped, WITH_CRON_BRAND, { value: true, enumerable: false })
  return wrapped
}
