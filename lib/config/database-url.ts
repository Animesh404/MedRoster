/**
 * Resolves which database the app talks to.
 *
 * Kept deliberately dependency-free — no Zod, no Next, no `@/` imports — because
 * `prisma.config.ts` and the Prisma CLI load this outside the Next build, where
 * path aliases and the framework runtime are not available.
 */

export type AppEnv = 'development' | 'production'

export const APP_ENVS: readonly AppEnv[] = ['development', 'production']

export function isAppEnv(value: string | undefined): value is AppEnv {
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
