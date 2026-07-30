import { notFound } from 'next/navigation'
import { currentSessionUser } from '@/lib/auth/session'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { needsPassword } from '@/app/auth/invite-branch'
import { PageHero } from '@/components/page-hero'
import { ChangePasswordForm } from './change-password-form'

export default async function AccountPage() {
  const session = await currentSessionUser()
  if (!session) notFound() // middleware already guards this route

  // currentSessionUser() doesn't carry identities — it's built from the
  // profile row, not the auth user — so a second call is needed for the one
  // thing that decides whether this member has a password to verify.
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getUser()
  const hasPassword = needsPassword(data.user?.identities)

  return (
    <div className="space-y-8">
      <PageHero eyebrow="Account" title="Account settings">
        <p className="max-w-prose text-white/85">
          {hasPassword
            ? 'Change the password you sign in with.'
            : 'You signed in with Google. Add a password to also be able to sign in without it.'}
        </p>
      </PageHero>

      <div className="max-w-sm">
        <ChangePasswordForm email={session.email} hasPassword={hasPassword} />
      </div>
    </div>
  )
}
