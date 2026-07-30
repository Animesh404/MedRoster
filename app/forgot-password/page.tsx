'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'

const CONFIRMATION = 'If that address is on the roster, a reset link is on its way.'

/**
 * Deliberately tells the same story whether the address is a real member,
 * a former one, or was never on the roster at all. Supabase's own response
 * already does this (it never errors just because a user is missing), but
 * this page must not add a distinguishing signal of its own — e.g. by only
 * showing the confirmation after a successful call and something else
 * otherwise — or it becomes a way to enumerate which emails are staff.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })
    setPending(false)
    setSubmitted(true)
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6 sm:p-10">
      <div className="w-full max-w-sm space-y-8">
        <Link href="/" className="font-display text-lg font-semibold text-brand-deep dark:text-brand-mid">
          MedRoster
        </Link>
        <div className="space-y-1">
          <h2 className="font-display text-2xl font-semibold">Forgot your password?</h2>
          <p className="text-sm text-muted-foreground">
            Enter the email address on your account and we&apos;ll send a link to reset it.
          </p>
        </div>
        {submitted ? (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
            {CONFIRMATION}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        )}
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
