import { execSync } from 'node:child_process'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

let container: StartedPostgreSqlContainer | undefined
let client: PrismaClient | undefined

/**
 * Boots one Postgres container per test file and migrates it.
 *
 * Prisma 7 removed the `datasources: { db: { url } }` constructor override in
 * favor of driver adapters, so the Testcontainers connection string is wired
 * in through `@prisma/adapter-pg` rather than passed straight to `PrismaClient`.
 */
export async function getTestDb(): Promise<PrismaClient> {
  if (client) return client
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
  const adapter = new PrismaPg({ connectionString: url })
  client = new PrismaClient({ adapter })
  return client
}

/**
 * Truncates every application table between tests.
 *
 * DERIVED from the database rather than hand-listed, deliberately. The hand-
 * written list silently went stale twice — once for `MutationOutcome` and again
 * for `OutboxWatermark` — and the failure mode is nasty rather than obvious:
 * ids `RESTART IDENTITY` back to 1 while the forgotten table keeps its rows, so
 * a later test sees another test's data under a colliding id and quietly agrees
 * with it. Asking Postgres what exists cannot go stale.
 *
 * Scoped to `public`, which is what Prisma owns. Supabase's own `auth`,
 * `storage` and `realtime` schemas live alongside it in the same database and
 * must never be touched — truncating those would destroy every account.
 * `_prisma_migrations` is excluded for the obvious reason.
 */
export async function resetTestDb(): Promise<void> {
  const db = await getTestDb()
  const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `)
  if (tables.length === 0) return

  const quoted = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
  await db.$executeRawUnsafe(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`)
}

export async function stopTestDb(): Promise<void> {
  await client?.$disconnect()
  await container?.stop()
  client = undefined
  container = undefined
}
