import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression for the seeding workflow being silently broken two independent
 * ways, discovered by actually running `npm run db:seed` / `npx prisma db
 * seed` / `npx prisma migrate reset` against a fresh local database rather
 * than just reading the code:
 *
 *  1. `npx prisma db seed` (and therefore the auto-seed step of
 *     `npx prisma migrate reset`) printed "No seed command configured" and
 *     did nothing — Prisma 7 reads the seed command from `prisma.config.ts`'s
 *     `migrations.seed`, and once a `prisma.config.ts` exists, package.json's
 *     legacy `"prisma": { "seed": ... }` field (still present, and correct,
 *     but no longer consulted) is silently ignored.
 *  2. `npm run db:seed` (`tsx prisma/seed.ts` run directly, with no Prisma
 *     CLI in front of it to have already loaded `.env`) threw `ConfigError:
 *     APP_ENV is "development", so DATABASE_URL_DEV must be set` — `.env`
 *     sets it, but nothing had loaded `.env` into `process.env` yet.
 *
 * Both are config-wiring facts a unit test can't observe by importing the
 * modules under test (`prisma.config.ts` has real side effects — it resolves
 * and logs the live database target on import — so tests don't execute it;
 * see `tests/config/database-url.test.ts`'s dependency-injected style
 * instead), so this checks the source directly. This mirrors the same
 * "cheap but real" trade-off `tests/rbac/routes.test.ts` makes for its own
 * regex smoke check: not proof the command runs end to end, but a fast,
 * specific guard against this exact wiring silently regressing again.
 */
describe('database seeding is wired up', () => {
  it('prisma.config.ts declares migrations.seed, so `prisma db seed` / `migrate reset` can find it', () => {
    const src = readFileSync('prisma.config.ts', 'utf8')
    const migrationsIdx = src.indexOf('migrations:')
    const seedIdx = src.indexOf("seed: 'tsx prisma/seed.ts'")
    expect(migrationsIdx, 'prisma.config.ts must configure `migrations`').toBeGreaterThanOrEqual(0)
    expect(seedIdx, "prisma.config.ts must set migrations.seed to 'tsx prisma/seed.ts'").toBeGreaterThanOrEqual(0)
    expect(seedIdx, 'seed must be declared inside the migrations block').toBeGreaterThan(migrationsIdx)
  })

  it('prisma/seed.ts loads dotenv before anything that reads DATABASE_URL_DEV from process.env', () => {
    const src = readFileSync('prisma/seed.ts', 'utf8')
    const dotenvIdx = src.indexOf("import 'dotenv/config'")
    const dbClientIdx = src.indexOf("@/lib/db/client")
    expect(dotenvIdx, 'prisma/seed.ts must import dotenv/config').toBeGreaterThanOrEqual(0)
    expect(dbClientIdx, 'prisma/seed.ts must import @/lib/db/client').toBeGreaterThanOrEqual(0)
    expect(dotenvIdx, 'dotenv/config must be imported before @/lib/db/client resolves DATABASE_URL_DEV')
      .toBeLessThan(dbClientIdx)
  })
})
