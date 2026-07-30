import { describe, expect, it } from 'vitest'
import { getServerEnv, resetServerEnvCache } from '@/lib/config/env'

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
