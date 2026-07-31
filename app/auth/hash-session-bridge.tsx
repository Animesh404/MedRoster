'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'

/**
 * Turns the tokens Supabase leaves in the URL fragment into a real session.
 *
 * MedRoster ships `{{ .TokenHash }}` email templates that point at
 * `/auth/confirm`, where the server exchanges the hash and sets the cookie
 * itself. Those templates cannot be installed on a free-tier project using
 * Supabase's built-in mailer — the Management API refuses with "Email template
 * modification is not available for free tier projects using the default email
 * provider" — so this deployment sends Supabase's DEFAULT templates instead.
 *
 * Measured, rather than assumed, by generating a real link:
 *
 *   GET  https://<ref>.supabase.co/auth/v1/verify?token=…&type=recovery
 *   303  https://<app>/auth/reset-password#access_token=…&refresh_token=…&type=recovery
 *
 * Everything after the `#` is a fragment, and a browser never sends a fragment
 * to the server. That is the whole problem: the server route sees a bare URL
 * and concludes the link was never valid. Only a client can read it, which is
 * why this is a client component and cannot be anything else.
 *
 * The tokens are removed from the address bar with `replaceState` as soon as
 * they are spent, so a refresh cannot replay them and they do not sit in
 * browser history or leak through a `Referer` header.
 *
 * Renders nothing, and holds no state. Every page that mounts it already says
 * something useful while it works — "Finishing sign-in", or the invite form's
 * own empty state — so a spinner here would only be a second thing to keep in
 * sync, and the React Compiler is right to flag setState in an effect body.
 */
export function HashSessionBridge({ onFailure = '/login' }: { onFailure?: string }) {
  const router = useRouter()

  useEffect(() => {
    const raw = window.location.hash.slice(1)
    if (raw === '') return

    const params = new URLSearchParams(raw)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    const error = params.get('error_description') ?? params.get('error')

    // An expired or already-used link comes back as an error in the same
    // fragment. Clear it and let the page render its own "no session" branch,
    // which already says the useful thing.
    if (error !== null && accessToken === null) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      // Nothing to announce: the page's own signed-out branch already renders
      // "this link is no longer valid", which is the accurate message.
      return
    }

    if (accessToken === null || refreshToken === null) return

    const supabase = createSupabaseBrowserClient()

    void supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          // Spend the tokens even on failure: one left in the URL is
          // replayable by anyone who gets the history entry, and a rejected
          // token is no less sensitive than an accepted one.
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
          router.replace(onFailure)
          return
        }

        // A FULL navigation, not `router.refresh()`.
        //
        // `refresh()` was the first attempt and it does not work here: it
        // re-fetches the RSC payload before the browser client has committed
        // its auth cookies, so the server re-renders the signed-out branch and
        // nothing tries again. Measured — the page sat on "this link is no
        // longer valid" while the cookie was present and a manual reload
        // showed the password form immediately.
        //
        // `location.replace` guarantees the request carries the cookie, and
        // drops the fragment in the same step. It costs a full page load on a
        // path somebody walks once per invite.
        window.location.replace(window.location.pathname + window.location.search)
      })
  }, [router, onFailure])

  return null
}
