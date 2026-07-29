import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  describeDatabaseTarget,
  redactDatabaseUrl,
  resolveDatabase,
} from '@/lib/config/database-url'

const DEV = 'postgresql://medroster:medroster@localhost:5432/medroster'
const PROD = 'postgresql://postgres.abc:sekrit@aws-0-eu-west-2.pooler.supabase.com:5432/postgres'

describe('resolveDatabase', () => {
  it('defaults to development when APP_ENV is unset', () => {
    const r = resolveDatabase({ DATABASE_URL_DEV: DEV })
    expect(r).toMatchObject({ url: DEV, source: 'DATABASE_URL_DEV', appEnv: 'development' })
  })

  it('selects the production url when APP_ENV=production', () => {
    const r = resolveDatabase({
      APP_ENV: 'production', DATABASE_URL_DEV: DEV, DATABASE_URL_PROD: PROD,
    })
    expect(r).toMatchObject({ url: PROD, source: 'DATABASE_URL_PROD', appEnv: 'production' })
  })

  it('lets an explicit DATABASE_URL win over APP_ENV', () => {
    // This is what keeps docker compose, Testcontainers and CI working: each
    // injects a URL that knows better than APP_ENV does.
    const injected = 'postgresql://test:test@localhost:54321/testcontainer'
    const r = resolveDatabase({
      APP_ENV: 'production', DATABASE_URL: injected, DATABASE_URL_PROD: PROD,
    })
    expect(r).toMatchObject({ url: injected, source: 'DATABASE_URL' })
  })

  it('ignores an empty DATABASE_URL rather than treating it as an override', () => {
    const r = resolveDatabase({ DATABASE_URL: '   ', DATABASE_URL_DEV: DEV })
    expect(r.source).toBe('DATABASE_URL_DEV')
  })

  it('names the missing variable when the selected one is absent', () => {
    expect(() => resolveDatabase({ APP_ENV: 'production' }))
      .toThrow(/DATABASE_URL_PROD must be set/)
  })

  it('rejects an APP_ENV that is neither development nor production', () => {
    // "staging" silently falling back to the dev database would be the worst
    // possible outcome — a typo must be loud.
    expect(() => resolveDatabase({ APP_ENV: 'staging', DATABASE_URL_DEV: DEV }))
      .toThrow(ConfigError)
  })
})

describe('describeDatabaseTarget', () => {
  it.each([
    [DEV, 'local'],
    ['postgresql://u:p@db:5432/medroster', 'local'],
    [PROD, 'supabase'],
    ['postgresql://u:p@some.rds.amazonaws.com:5432/x', 'other'],
  ])('classifies %s as %s', (url, expected) => {
    expect(describeDatabaseTarget(url)).toBe(expected)
  })
})

describe('redactDatabaseUrl', () => {
  it('removes the password so a resolved url is safe to log', () => {
    const out = redactDatabaseUrl(PROD)
    expect(out).not.toContain('sekrit')
    expect(out).toContain('pooler.supabase.com')
  })
})
