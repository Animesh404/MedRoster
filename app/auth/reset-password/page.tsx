import type { Metadata } from 'next'
import Link from 'next/link'
import { SetPasswordForm } from '@/app/auth/set-password-form'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Reset password — MedRoster',
}

export default async function ResetPasswordPage() {
  // Same mechanism as accept-invite: the recovery email template points at
  // /auth/confirm with type=recovery, which exchanges the token hash and
  // sets the session cookie before redirecting here. This page never parses
  // a token itself.
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()

  return (
    <div className="flex min-h-screen items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-sm space-y-8">
        <Link href="/" className="font-display text-lg font-semibold text-brand-deep dark:text-brand-mid">
          MedRoster
        </Link>
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
