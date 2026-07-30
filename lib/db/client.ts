import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { resolveDatabase } from '@/lib/config/database-url'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createPrisma(): PrismaClient {
  // Resolved rather than read straight from DATABASE_URL, so APP_ENV selects the
  // target. An explicit DATABASE_URL still wins, which keeps docker compose,
  // Testcontainers and CI working unchanged.
  const { url } = resolveDatabase()

  // Prisma 7 removed the `datasources: { db: { url } }` constructor override in
  // favour of mandatory driver adapters, so the connection is wired through
  // @prisma/adapter-pg rather than passed straight to PrismaClient.
  // Pool size is deliberate, not inherited. node-postgres defaults to max 10,
  // and `withOrderedLocks` serialises every claimant of one shift behind a
  // single advisory lock — a transaction blocked on that lock still holds its
  // connection. Ten connections therefore cap how many claimants can even be
  // queued before the rest start timing out at the pool rather than at the
  // lock, which is the P2028/P2024 failure in docs/KNOWN_ISSUES.md.
  //
  // Overridable because the right number is deployment-specific: Supabase's
  // pooler and a local Postgres have very different budgets, and a serverless
  // deployment multiplies this by its instance count.
  const maxConnections = Number(process.env.DATABASE_POOL_MAX ?? 20)
  const adapter = new PrismaPg({ connectionString: url, max: maxConnections })

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

/**
 * Constructed on FIRST USE, not at import.
 *
 * `resolveDatabase()` throws a deliberately loud error when no database is
 * configured, which is right — but it must not fire merely because a module was
 * imported. The route-authorisation test imports every `app/api/**\/route.ts` to
 * inspect its exports, and those pull in this file transitively; in that
 * environment there is no `.env` and no database is wanted. Resolving eagerly
 * turned "import this module" into "have a database", and took nine route tests
 * down with it.
 *
 * The proxy keeps the fail-fast error exactly where it is useful — the first
 * real query — while leaving import side-effect free.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = (globalForPrisma.prisma ??= createPrisma())
    const value = Reflect.get(client, prop, receiver)
    // Methods must stay bound to the real client, or `this` is the proxy.
    return typeof value === 'function' ? value.bind(client) : value
  },
})

// In production a fresh module instance per lambda is correct; in dev the
// global cache is what stops hot reload leaking connections.
if (process.env.NODE_ENV === 'production') {
  delete globalForPrisma.prisma
}
