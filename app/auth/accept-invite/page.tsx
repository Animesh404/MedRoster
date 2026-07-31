import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { inviteDestination } from '@/app/auth/invite-branch'
import { HashSessionBridge } from '@/app/auth/hash-session-bridge'
import { SetPasswordForm } from '@/app/auth/set-password-form'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Accept invite — MedRoster',
}

export default async function AcceptInvitePage() {
  // By the time this renders, Task 7's /auth/confirm has already exchanged
  // the token hash and set the session cookie, so getUser() genuinely
  // returns the invitee here — this page never parses a token itself.
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
          // No session AND no fragment for the bridge to spend. Either the
          // link expired, or somebody opened this URL directly. The bridge
          // calls `router.refresh()` after a successful exchange, so a
          // fragment-carrying visit re-renders into the branch below rather
          // than sitting on this message.
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            This invite link is no longer valid. Ask a manager to resend it.
          </p>
        ) : (
          <AcceptInviteBody identities={data.user.identities} />
        )}
      </div>
    </div>
  )
}

function AcceptInviteBody({ identities }: { identities: { provider: string }[] | null | undefined }) {
  // An invitee who accepted via Google has no password to set — identity
  // linking removed the unconfirmed email identity, so this form could never
  // succeed for them. Send them straight in. The decision itself lives in
  // inviteDestination (tested exhaustively in tests/auth/invite-branch.test.ts);
  // this is just the acting on it.
  if (inviteDestination(identities) === 'dashboard') {
    redirect('/dashboard')
  }

  return (
    <SetPasswordForm heading="Set your password" submitLabel="Set password and continue" redirectTo="/dashboard" />
  )
}
