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

export async function resetTestDb(): Promise<void> {
  const db = await getTestDb()
  await db.$executeRawUnsafe(`
    TRUNCATE "Claim", "ShiftRequirement", "Shift", "ShiftSeries",
             "ImportRowResult", "ImportRun", "EventOutbox", "MutationOutcome",
             "User" RESTART IDENTITY CASCADE
  `)
}

export async function stopTestDb(): Promise<void> {
  await client?.$disconnect()
  await container?.stop()
  client = undefined
  container = undefined
}
