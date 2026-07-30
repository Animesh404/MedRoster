import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getClientEnv, getServerEnv } from '@/lib/config/env'

/**
 * Service-role Supabase client. Bypasses every access rule.
 *
 * Two guards, catching the same condition at different times:
 * the `server-only` import above fails the BUILD the moment this module is
 * bundled for the client, however it got there; tests/auth/admin-containment.test.ts
 * fails `npm test` on that same condition first, by statically walking the
 * import graph for any client-reachable file that transitively imports this
 * module — so the failure shows up before anyone runs a build.
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
