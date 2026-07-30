import { afterEach, describe, expect, it } from 'vitest'
import { getClientEnv, getServerEnv, resetServerEnvCache } from '@/lib/config/env'

const VALID = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  APP_URL: 'http://localhost:3000',
} as const

function envWith(overrides: Record<string, string | undefined>) {
  return { ...VALID, ...overrides }
}

describe('getServerEnv', () => {
  it('returns the service role key and app url', () => {
    resetServerEnvCache()
    const env = getServerEnv(envWith({}))
    expect(env.supabaseServiceRoleKey).toBe('service-role-key')
    expect(env.appUrl).toBe('http://localhost:3000')
  })

  it('names SUPABASE_SERVICE_ROLE_KEY when it is missing', () => {
    resetServerEnvCache()
    expect(() => getServerEnv(envWith({ SUPABASE_SERVICE_ROLE_KEY: undefined })))
      .toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('rejects an APP_URL that is not an absolute origin', () => {
    resetServerEnvCache()
    expect(() => getServerEnv(envWith({ APP_URL: '/dashboard' }))).toThrow(/APP_URL/)
  })

  it('no longer requires AUTH_SECRET', () => {
    resetServerEnvCache()
    expect(() => getServerEnv(envWith({}))).not.toThrow()
  })
})

describe('getClientEnv', () => {
  // getClientEnv() reads process.env directly by literal name (see the
  // comment on its definition — Next inlines NEXT_PUBLIC_* by exact textual
  // match, so it can't take an injectable env object the way getServerEnv
  // does). tests/setup.ts deliberately leaves both of these unset for every
  // other test file — see its comment — so each case here must set only what
  // it needs and restore the prior value afterwards, never leak a default.
  const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const ORIGINAL_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL

    if (ORIGINAL_KEY === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = ORIGINAL_KEY
  })

  it('returns both values and reports realtime configured when both are set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-key'

    const env = getClientEnv()
    expect(env.supabaseUrl).toBe('http://127.0.0.1:54321')
    expect(env.supabasePublishableKey).toBe('publishable-key')
    expect(env.realtimeConfigured).toBe(true)
  })

  it('names NEXT_PUBLIC_SUPABASE_URL when it is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-key'

    expect(() => getClientEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('names NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY when it is missing', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

    expect(() => getClientEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/)
  })
})
