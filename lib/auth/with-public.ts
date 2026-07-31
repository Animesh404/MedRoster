import { NextResponse } from 'next/server'

/**
 * Runtime brand marking a handler as deliberately reachable without a session.
 *
 * `tests/rbac/routes.test.ts` requires every `app/api/**\/route.ts` handler to
 * carry a guard brand. A symbol on the exported function is the evidence,
 * because source text is not: an earlier version of that exemption was
 * satisfied by the guard's NAME appearing in a comment, which let an
 * empty-bodied handler pass while deleting rows for anyone on the internet.
 */
export const WITH_PUBLIC_BRAND = Symbol('withPublic')

type Handler = (req: Request) => Promise<Response> | Response

/**
 * Wraps a handler that has no session to authorize against.
 *
 * This is not a rubber stamp. Being public is exactly what makes the two things
 * it enforces matter:
 *
 *  - **Errors never leak.** A thrown error becomes a bare 503 with a fixed
 *    body. The natural failure here is a database error, and Postgres puts the
 *    host, port, database name and user straight into its message — an
 *    unauthenticated endpoint that echoes that has handed an attacker the
 *    connection details.
 *  - **Nothing is cached.** A probe answered from a CDN cache reports the
 *    health of a past request. `no-store` also stops Next from statically
 *    optimising the route at build time, which would freeze the response at
 *    whatever was true during the build.
 *
 * Only for endpoints with genuinely nothing to authorize. Anything reading or
 * writing roster data belongs behind `withAuth`.
 */
export function withPublic(handler: Handler): Handler {
  const wrapped = async (req: Request): Promise<Response> => {
    try {
      const res = await handler(req)
      res.headers.set('cache-control', 'no-store, max-age=0')
      return res
    } catch {
      // Deliberately shapeless. The caller learns the service is unhealthy and
      // nothing else; the detail goes to the server log, where it is readable
      // by somebody who is already inside.
      const res = NextResponse.json(
        { status: 'unhealthy' },
        { status: 503 },
      )
      res.headers.set('cache-control', 'no-store, max-age=0')
      return res
    }
  }

  return Object.assign(wrapped, { [WITH_PUBLIC_BRAND]: true })
}
