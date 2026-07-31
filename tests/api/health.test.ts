import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { GET } = await import('@/app/api/health/route')

beforeEach(resetTestDb)
afterAll(stopTestDb)

const req = () => new Request('http://localhost/api/health')

describe('GET /api/health', () => {
  it('reports ok while the database answers', async () => {
    const res = await GET(req())

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok' })
  })

  /**
   * The whole reason the probe queries rather than just returning 200. A pooled
   * client happily holds a handle to a database that has gone away; only
   * running a statement finds out. An instance that cannot reach Postgres
   * cannot serve a single page that matters, so it must not stay in rotation.
   */
  it('returns 503 when the database cannot be reached', async () => {
    const db = await getTestDb()
    const spy = vi.spyOn(db, '$queryRaw').mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    )

    const res = await GET(req())

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'unhealthy', database: 'unreachable' })
    spy.mockRestore()
  })

  // 503 is what load balancers, uptime monitors and the go-live gate read.
  // A 200 carrying `status: "unhealthy"` keeps a broken instance serving.
  it('signals failure in the status code, not only the body', async () => {
    const db = await getTestDb()
    const spy = vi.spyOn(db, '$queryRaw').mockRejectedValueOnce(new Error('down'))

    expect((await GET(req())).status).not.toBe(200)
    spy.mockRestore()
  })

  /**
   * Unauthenticated, so the failure path must not describe the failure.
   * Postgres puts host, port, database name and user directly into its error
   * messages; echoing one hands over the connection details.
   */
  it('never leaks the underlying error to an anonymous caller', async () => {
    const db = await getTestDb()
    const secret = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.4:5432/medroster_prod'
    const spy = vi.spyOn(db, '$queryRaw').mockRejectedValueOnce(new Error(secret))

    const body = await (await GET(req())).text()

    expect(body).not.toContain('hunter2')
    expect(body).not.toContain('10.0.0.4')
    expect(body).not.toContain('ECONNREFUSED')
    spy.mockRestore()
  })

  // A probe answered from a cache reports the health of a past request.
  it('forbids caching', async () => {
    const res = await GET(req())
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  // So a deploy can be verified as actually live rather than assumed from a
  // green pipeline.
  it('names the build that is answering', async () => {
    const body = await (await GET(req())).json() as { commit: string }
    expect(typeof body.commit).toBe('string')
    expect(body.commit.length).toBeGreaterThan(0)
  })

  it('reports how long the database round trip took', async () => {
    const body = await (await GET(req())).json() as { checkedInMs: number }
    expect(body.checkedInMs).toBeGreaterThanOrEqual(0)
    expect(body.checkedInMs).toBeLessThan(30_000)
  })
})
