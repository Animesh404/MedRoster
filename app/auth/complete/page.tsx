import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { HashSessionBridge } from '@/app/auth/hash-session-bridge'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Signing in — MedRoster',
}

/**
 * Where a magic-link sign-in lands.
 *
 * It used to point at `/auth/callback`, a route handler — which works for the
 * OAuth code exchange it was written for, and cannot work here. Supabase's
 * default email template returns the session in the URL FRAGMENT, and a route
 * handler is server-side, so it received a bare URL and treated every valid
 * link as invalid.
 *
 * A page can render a client component; a route handler cannot. That is the
 * entire reason this exists as a separate path rather than more branching
 * inside the callback route.
 */
export default async function AuthCompletePage() {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()

  // The bridge calls `router.refresh()` once it has spent the fragment, so the
  // second render of this page reaches here with a real user and moves on.
  if (data.user) {
    redirect('/dashboard')
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-sm space-y-6 text-center">
        <Link href="/" className="font-display text-lg font-semibold text-brand-deep dark:text-brand-mid">
          MedRoster
        </Link>
        <HashSessionBridge />
        <p className="text-sm text-muted-foreground">
          Finishing sign-in. If nothing happens, the link may have expired —{' '}
          <Link href="/login" className="font-medium underline">
            request a new one
          </Link>
          .
        </p>
      </div>
    </div>
  )
}
