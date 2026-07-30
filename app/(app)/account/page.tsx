import Link from 'next/link'
import { notFound } from 'next/navigation'
import { currentSessionUser } from '@/lib/auth/session'
import { PageHero } from '@/components/page-hero'
import { ChangePasswordForm } from './change-password-form'

export default async function AccountPage() {
  const session = await currentSessionUser()
  if (!session) notFound() // middleware already guards this route

  return (
    <div className="space-y-8">
      <PageHero eyebrow="Account" title="Account settings">
        <p className="max-w-prose text-white/85">Change the password you sign in with.</p>
      </PageHero>

      <div className="max-w-sm space-y-4">
        <ChangePasswordForm email={session.email} />
        {/* A member with no password yet (e.g. signed in via Google) is not
         *  blocked here — this form always asks for a current password, on
         *  purpose (see the comment in change-password-form.tsx). They set
         *  their first password through the existing recovery flow instead:
         *  proving control of the inbox is a real authorisation, unlike any
         *  guess this page could make from identity records. */}
        <p className="text-sm text-muted-foreground">
          Signed in with Google and want a password? Use{' '}
          <Link href="/forgot-password" className="text-primary underline-offset-4 hover:underline">
            Forgot your password?
          </Link>{' '}
          on the sign-in page to set one.
        </p>
      </div>
    </div>
  )
}
