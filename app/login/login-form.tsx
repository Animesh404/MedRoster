'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { createSupabaseBrowserClient } from '@/lib/supabase/browser'
import { loginAction, type LoginState } from './actions'
import { DEMO_ACCOUNTS } from './demo-accounts'

const INITIAL_STATE: LoginState = { error: null }

// The same non-committal wording as the forgot-password page, and for the
// same reason: whether the address is a real, invited member; a real member
// who was never invited; or not on the roster at all, the response must read
// identically, or the response itself becomes an enumeration signal.
const MAGIC_LINK_CONFIRMATION = 'If that address is on the roster, a sign-in link is on its way.'

export function LoginForm({
  next,
  demoPassword,
  error,
}: {
  next: string
  demoPassword: string
  error?: string | undefined
}) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL_STATE)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [magicLinkPending, setMagicLinkPending] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [googlePending, setGooglePending] = useState(false)

  function fillDemo(account: (typeof DEMO_ACCOUNTS)[number]) {
    setEmail(account.email)
    setPassword(demoPassword)
  }

  async function handleMagicLink() {
    setMagicLinkPending(true)
    const supabase = createSupabaseBrowserClient()
    // `shouldCreateUser: false` is mandatory and load-bearing: GoTrue's
    // otp.go never checks the project's disable-signups setting, so this
    // flag is the only thing standing between a stranger and an account on
    // the magic-link path. Do not remove it.
    try {
      await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` },
      })
    } catch {
      // Swallowed on purpose, same as the forgot-password page: a network
      // failure must render exactly like a successful send, or its absence
      // becomes its own enumeration signal.
    }
    setMagicLinkPending(false)
    setMagicLinkSent(true)
  }

  async function handleGoogle() {
    setGooglePending(true)
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    setGooglePending(false)
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next} />
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
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Link href="/forgot-password" className="text-sm text-primary underline-offset-4 hover:underline">
              Forgot your password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {state.error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or</span>
        </div>
      </div>

      <div className="space-y-3">
        {magicLinkSent ? (
          <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
            {MAGIC_LINK_CONFIRMATION}
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={magicLinkPending || !email}
            onClick={handleMagicLink}
          >
            {magicLinkPending ? 'Sending…' : 'Email me a sign-in link'}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={googlePending}
          onClick={handleGoogle}
        >
          {googlePending ? 'Redirecting…' : 'Continue with Google'}
        </Button>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Demo accounts</CardTitle>
          <CardDescription>
            One click fills the form above — every seeded account shares the same password.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => fillDemo(account)}
              className="rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="block font-medium">{account.label}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{account.email}</span>
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
