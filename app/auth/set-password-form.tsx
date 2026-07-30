'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'

const GENERIC_ERROR =
  'We could not set your password — the link may have expired. Ask a manager to resend your invite.'

/**
 * Shared by accept-invite and reset-password: both are "the session already
 * exists (Task 7's /auth/confirm set the cookie), now collect a password"
 * forms with identical validation and failure handling. The only thing that
 * differs between the two call sites is copy and where success lands.
 */
export function SetPasswordForm({
  heading,
  submitLabel,
  redirectTo,
}: {
  heading: string
  submitLabel: string
  redirectTo: string
}) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Use at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Those passwords do not match.')
      return
    }

    setPending(true)
    const supabase = createSupabaseBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setPending(false)

    if (updateError) {
      setError(GENERIC_ERROR)
      return
    }

    router.push(redirectTo)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <h2 className="font-display text-2xl font-semibold">{heading}</h2>
      <div className="space-y-1.5">
        <label htmlFor="new-password" className="text-sm font-medium">
          New password
        </label>
        <Input
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="confirm-password" className="text-sm font-medium">
          Confirm password
        </label>
        <Input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Saving…' : submitLabel}
      </Button>
    </form>
  )
}
