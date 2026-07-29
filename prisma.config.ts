import 'dotenv/config'
import { defineConfig } from 'prisma/config'
import { redactDatabaseUrl, resolveDatabase } from './lib/config/database-url'

/**
 * The Prisma CLI (`migrate`, `generate`, `db push`) runs outside the Next build,
 * so it cannot use `@/` path aliases or anything framework-shaped — hence the
 * relative import of a deliberately dependency-free resolver.
 *
 * Resolving here rather than reading `DATABASE_URL` directly is what makes
 * `APP_ENV=production npx prisma migrate deploy` target the right database. An
 * explicit `DATABASE_URL` still wins, which keeps `docker compose` and CI
 * working unchanged.
 */
const db = resolveDatabase()

// Migrations are irreversible against the wrong database, so always say which
// one is about to be touched.
console.log(`[prisma] APP_ENV=${db.appEnv} · via ${db.source} · ${redactDatabaseUrl(db.url)}`)

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: db.url,
  },
  migrations: {
    path: 'prisma/migrations',
  },
})
