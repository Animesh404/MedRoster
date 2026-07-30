import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getClientEnv } from '@/lib/config/env'

/**
 * Server-side Supabase client for RSCs, Server Actions and route handlers.
 *
 * Async because Next 15's `cookies()` is async.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies()
  const { supabaseUrl, supabasePublishableKey } = getClientEnv()

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Server Components are not allowed to set cookies, and Next throws
          // if you try. Safe to swallow: middleware.ts refreshes the session
          // on every matched request, so the refreshed token is still
          // persisted — just by the middleware response rather than here.
        }
      },
    },
  })
}
