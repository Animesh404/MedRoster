'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'

/**
 * Signed-in password change — and, for a Google-linked member with no
 * password yet, the first-time add. `hasPassword` (derived from the user's
 * identities, spec §5.4.2) decides both: whether a current-password field
 * and re-verification round-trip appear at all, and what the submit button
 * says.
 */
export function ChangePasswordForm({ email, hasPassword }: { email: string; hasPassword: boolean }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pending, setPending] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (newPassword.length < 8) {
      setError('Use at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Those passwords do not match.')
      return
    }

    setPending(true)
    const supabase = createSupabaseBrowserClient()

    if (hasPassword) {
      // Supabase's updateUser does NOT require the current password — a valid
      // session is enough. Re-verifying it here is what stops an unattended
      // signed-in browser from being a full account takeover. Do not "optimise"
      // this call away.
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      })
      if (verifyError) {
        setPending(false)
        setError('Your current password is incorrect.')
        return
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
    setPending(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setSuccess(true)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {hasPassword ? (
        <div className="space-y-1.5">
          <label htmlFor="current-password" className="text-sm font-medium">
            Current password
          </label>
          <Input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </div>
      ) : null}
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
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="confirm-password" className="text-sm font-medium">
          Confirm new password
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
      {success ? (
        <p role="status" className="rounded-md bg-secondary/50 px-3 py-2 text-sm text-secondary-foreground">
          Password changed.
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
      </Button>
    </form>
  )
}
