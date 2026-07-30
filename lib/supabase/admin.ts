import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getClientEnv, getServerEnv } from '@/lib/config/env'

/**
 * Service-role Supabase client. Bypasses every access rule.
 *
 * Two independent guards, because one is not enough for a key this dangerous:
 * the `server-only` import above makes importing this from a client module a
 * BUILD error, and tests/auth/admin-containment.test.ts makes it a TEST
 * failure — which fires in `npm test` long before anyone runs a build.
 *
 * No session persistence: this client acts as the service, never as a user,
 * so writing a session to storage would be meaningless and confusing.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const { supabaseUrl } = getClientEnv()
  const { supabaseServiceRoleKey } = getServerEnv()

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
