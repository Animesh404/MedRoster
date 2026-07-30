import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getClientEnv } from '@/lib/config/env'

/**
 * Browser-side Supabase client. Publishable key only — safe to ship to the
 * client bundle, which is exactly why the service-role client lives in a
 * separate module (./admin.ts) rather than behind a flag in this one.
 */
export function createSupabaseBrowserClient(): SupabaseClient {
  const { supabaseUrl, supabasePublishableKey } = getClientEnv()
  return createBrowserClient(supabaseUrl, supabasePublishableKey)
}
