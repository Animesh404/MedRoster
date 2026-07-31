import type { Metadata } from 'next'
import Link from 'next/link'
import { HashSessionBridge } from '@/app/auth/hash-session-bridge'
import { SetPasswordForm } from '@/app/auth/set-password-form'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Reset password — MedRoster',
}

export default async function ResetPasswordPage() {
  // Two ways a session can be here, and both are supported on purpose:
  // a `{{ .TokenHash }}` template exchanged server-side by /auth/confirm, or —
  // on a project that cannot install custom templates — Supabase's default
  // template, which lands the tokens in the URL fragment for HashSessionBridge
  // below to spend. This render sees only the former.
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()

  return (
    <div className="flex min-h-screen items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-sm space-y-8">
        <Link href="/" className="font-display text-lg font-semibold text-brand-deep dark:text-brand-mid">
          MedRoster
        </Link>
        {/* Runs on the client before the branch below is trustworthy: with
            Supabase's default templates the session arrives in the URL
            fragment, which this server render cannot see. */}
        <HashSessionBridge />
        {!data.user ? (
          // No session means the link was never exchanged, already used, or
          // someone opened this URL directly. /auth/confirm redirects its
          // own failures to /login with a reason, so there is nothing to
          // recover here.
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This password reset link is no longer valid. Request a new one.
          </p>
        ) : (
          <SetPasswordForm heading="Choose a new password" submitLabel="Save new password" redirectTo="/dashboard" />
        )}
      </div>
    </div>
  )
}
