import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withPublic } from '@/lib/auth/with-public'

/**
 * Readiness probe. The go-live gate's availability signal, and what a platform
 * health check should point at.
 *
 * **Readiness, not liveness.** It answers "can this instance serve a real
 * request?", which for MedRoster means the database is reachable — every page
 * that matters reads from it, so an instance that is up but cannot reach
 * Postgres is not serving anybody. A probe that only proved the Node process
 * was running would go green during exactly the outage worth catching.
 *
 * The payload is deliberately thin. This endpoint is unauthenticated, so it
 * says whether the service works and which build is answering, and nothing
 * about how it is configured — no connection strings, no environment, no row
 * counts. `commit` is there so a deploy can be verified as actually live
 * rather than assumed from a green pipeline.
 */

// Never prerendered: a health check baked at build time reports the health of
// the build machine, forever.
export const dynamic = 'force-dynamic'

const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? 'unknown').slice(0, 7)

export const GET = withPublic(async () => {
  const startedAt = Date.now()

  let database: 'ok' | 'unreachable' = 'ok'
  try {
    // The cheapest possible round trip that still proves a real connection was
    // established and a query executed. A pooled client can hold a handle to a
    // database that has since gone away; only a query finds that out.
    await prisma.$queryRaw`SELECT 1`
  } catch {
    database = 'unreachable'
  }

  const healthy = database === 'ok'

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'unhealthy',
      database,
      commit: COMMIT,
      // Round-trip time to the database, which is the thing most likely to
      // degrade before it fails outright.
      checkedInMs: Date.now() - startedAt,
    },
    // 503, not 200-with-a-sad-field: load balancers, uptime monitors and the
    // go-live gate all read the STATUS CODE. Returning 200 for an unhealthy
    // instance keeps it in rotation.
    { status: healthy ? 200 : 503 },
  )
})
