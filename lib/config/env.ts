import { z } from 'zod'
import {
  ConfigError,
  describeDatabaseTarget,
  redactDatabaseUrl,
  resolveDatabase,
  type AppEnv,
} from './database-url'

export { ConfigError, describeDatabaseTarget, redactDatabaseUrl, resolveDatabase }
export type { AppEnv }

/**
 * Validated configuration, in one place.
 *
 * Two rules this file exists to enforce:
 *
 *  - **Server secrets never reach the browser.** Only `NEXT_PUBLIC_*` values are
 *    inlined into the client bundle by Next, so anything else lives behind
 *    `getServerEnv()`, which refuses to run outside Node.
 *  - **Fail loudly at boot, not obscurely at runtime.** A missing AUTH_SECRET
 *    should say so by name, not surface three layers down as a decrypt failure.
 */

const serverSchema = z.object({
  AUTH_SECRET: z
    .string()
    .min(1, 'AUTH_SECRET is required — generate one with `openssl rand -base64 32`'),
  CLINIC_TZ: z.string().min(1).default('Europe/London'),
  SEED_PASSWORD: z.string().min(1).default('medroster123'),
})

const clientSchema = z.object({
  /**
   * Both halves are required together or realtime is treated as unconfigured.
   * A url without a key connects and then silently delivers nothing, which is
   * worse than not connecting — the UI would report itself live while missing
   * every update. Absent either, the app falls back to polling, which works
   * fully.
   */
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional().or(z.literal('')),
})

export interface ServerEnv {
  appEnv: AppEnv
  databaseUrl: string
  /** Which variable the database URL came from — surfaced in the boot banner. */
  databaseSource: string
  authSecret: string
  clinicTz: string
  seedPassword: string
}

let cached: ServerEnv | undefined

/**
 * Server-only configuration. Throws a readable, aggregated error rather than
 * letting a missing value fail somewhere unhelpful later.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached

  if (typeof window !== 'undefined') {
    throw new ConfigError(
      'getServerEnv() was called in the browser. Server configuration must never ' +
        'reach the client bundle — use getClientEnv() for NEXT_PUBLIC_ values.',
    )
  }

  const db = resolveDatabase()
  const parsed = serverSchema.safeParse(process.env)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new ConfigError(`Invalid server configuration:\n${details}`)
  }

  cached = {
    appEnv: db.appEnv,
    databaseUrl: db.url,
    databaseSource: db.source,
    authSecret: parsed.data.AUTH_SECRET,
    clinicTz: parsed.data.CLINIC_TZ,
    seedPassword: parsed.data.SEED_PASSWORD,
  }
  return cached
}

export interface ClientEnv {
  supabaseUrl: string
  supabasePublishableKey: string
  /** True only when BOTH halves are present — see the schema comment above. */
  realtimeConfigured: boolean
}

export function getClientEnv(): ClientEnv {
  // Read each name as a full literal: Next replaces `process.env.NEXT_PUBLIC_X`
  // by exact textual match at build time, so a computed key would come back
  // undefined in the browser.
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  })

  const url = (parsed.success ? parsed.data.NEXT_PUBLIC_SUPABASE_URL : '') ?? ''
  const key = (parsed.success ? parsed.data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY : '') ?? ''

  return {
    supabaseUrl: url,
    supabasePublishableKey: key,
    realtimeConfigured: Boolean(url) && Boolean(key),
  }
}

/**
 * One line at boot naming which database is in use and where the choice came
 * from. Cheap insurance against the failure this config exists to prevent:
 * believing you are on local data when you are not.
 */
export function describeBootConfig(): string {
  const env = getServerEnv()
  const target = describeDatabaseTarget(env.databaseUrl)
  return (
    `MedRoster · APP_ENV=${env.appEnv} · db=${target} (via ${env.databaseSource}) ` +
    `· ${redactDatabaseUrl(env.databaseUrl)}`
  )
}
