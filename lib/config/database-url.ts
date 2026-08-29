/**
 * Resolves which database the app talks to.
 *
 * Kept deliberately dependency-free — no Zod, no Next, no `@/` imports — because
 * `prisma.config.ts` and the Prisma CLI load this outside the Next build, where
 * path aliases and the framework runtime are not available.
 */

export type AppEnv = 'development' | 'production'

const APP_ENVS: readonly AppEnv[] = ['development', 'production']

function isAppEnv(value: string | undefined): value is AppEnv {
  return value === 'development' || value === 'production'
}

/** Where a resolved URL came from, so errors and boot logs can say. */
export interface ResolvedDatabase {
  url: string
  source: 'DATABASE_URL' | 'DATABASE_URL_DEV' | 'DATABASE_URL_PROD'
  appEnv: AppEnv
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Precedence, highest first:
 *
 *  1. An explicit `DATABASE_URL`. This is the escape hatch, and it must stay
 *     first: `docker compose` injects one, Testcontainers hands each test file a
 *     throwaway URL, and CI sets its own. Those callers know better than
 *     APP_ENV does, and silently overriding them would be a debugging nightmare.
 *  2. `DATABASE_URL_DEV` / `DATABASE_URL_PROD`, selected by `APP_ENV`.
 *
 * `APP_ENV` is separate from `NODE_ENV` on purpose. Next owns `NODE_ENV` and
 * forces it to "production" for any production build — including a build you
 * intend to run against the dev database. Reusing it would make it impossible to
 * express "production build, local data", which is exactly what you want when
 * reproducing a bug.
 */
export function resolveDatabase(
  // Typed as a plain record rather than NodeJS.ProcessEnv: this only ever reads
  // a handful of string keys, and demanding the full ProcessEnv shape (which
  // requires NODE_ENV) would force every caller and test to build a fake one.
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedDatabase {
  const rawAppEnv = env.APP_ENV?.trim()

  if (rawAppEnv !== undefined && rawAppEnv !== '' && !isAppEnv(rawAppEnv)) {
    throw new ConfigError(
      `APP_ENV must be one of ${APP_ENVS.join(' | ')} — got "${rawAppEnv}".`,
    )
  }

  const appEnv: AppEnv = isAppEnv(rawAppEnv) ? rawAppEnv : 'development'

  const explicit = env.DATABASE_URL?.trim()
  if (explicit) {
    return { url: explicit, source: 'DATABASE_URL', appEnv }
  }

  const key = appEnv === 'production' ? 'DATABASE_URL_PROD' : 'DATABASE_URL_DEV'
  const url = env[key]?.trim()

  if (!url) {
    throw new ConfigError(
      `APP_ENV is "${appEnv}", so ${key} must be set in .env — it is missing or empty.\n` +
        `Set ${key}, or set DATABASE_URL directly to override the APP_ENV choice.`,
    )
  }

  return { url, source: key, appEnv }
}

/**
 * Guards against the mistake this whole file exists to make visible: running
 * against the production database while believing you are local, or the reverse.
 * A dev URL pointing at Supabase, or a prod URL pointing at localhost, is almost
 * always a paste error rather than an intention.
 */
export function describeDatabaseTarget(url: string): 'local' | 'supabase' | 'other' {
  if (/supabase\.(co|com)/i.test(url)) return 'supabase'
  if (/@(localhost|127\.0\.0\.1|db)[:/]/i.test(url)) return 'local'
  return 'other'
}

/** Redacts the password so a resolved URL can be logged or put in an error. */
export function redactDatabaseUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]+):[^@]*@/, '$1:***@')
}

/** Pool size for a long-lived host (docker compose, a local dev box, CI). */
const POOL_MAX_DEFAULT = 20

/**
 * Pool size per instance on a serverless host. One, deliberately: the platform
 * pooler in front of Postgres is doing the pooling, and a per-instance pool
 * competing with it is what causes exhaustion rather than what prevents it.
 */
const POOL_MAX_SERVERLESS = 1

/**
 * How many Postgres connections one process may hold.
 *
 * Split from a single constant because the right number is a property of the
 * DEPLOYMENT, not of the app, and the two deployments want opposite things:
 *
 *  - Locally, 20 is load-bearing. `withOrderedLocks` serialises every claimant
 *    of one shift behind a single advisory lock, and a blocked transaction
 *    still holds its connection — so too small a pool makes a claim burst time
 *    out at the POOL rather than queue at the lock. That is the P2028/P2024
 *    failure in docs/KNOWN_ISSUES.md, and 20 is the number that fixed it.
 *
 *  - On Vercel, 20 is actively harmful. Each lambda gets its OWN pool, so the
 *    figure is multiplied by the instance count, and it lands on a Supavisor
 *    pooler running session mode with pool_size 15. One instance could
 *    therefore exhaust the entire pooler on its own, which is what took
 *    production down on 2026-08-29:
 *
 *      (EMAXCONNSESSION) max clients reached in session mode
 *      - max clients are limited to pool_size: 15
 *
 * `DATABASE_POOL_MAX` still overrides both, because neither default can know
 * about a pooler resized in the Supabase dashboard.
 */
export function resolvePoolMax(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.DATABASE_POOL_MAX?.trim()

  if (!raw) {
    // Vercel sets VERCEL=1 in the build and at runtime, on every environment.
    return env.VERCEL ? POOL_MAX_SERVERLESS : POOL_MAX_DEFAULT
  }

  const parsed = Number(raw)

  // `Number()` alone turned a typo into NaN and handed it to node-postgres,
  // which is precisely the silent misconfiguration this file exists to make
  // loud. Fractional values are rejected too: a pool of 2.5 is a mistake.
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(
      `DATABASE_POOL_MAX must be a positive integer — got "${raw}".`,
    )
  }

  return parsed
}
