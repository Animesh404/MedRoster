'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/auth'

export interface LoginState {
  error: string | null
}

/**
 * Server Action behind the login form. Calls the imported `signIn` directly
 * (not the `next-auth/react` client hook) so `redirectTo` — the v5
 * server-side signIn option — does what it says without needing a
 * `/api/auth/[...nextauth]` round trip.
 *
 * `signIn` itself throws a Next.js redirect on success, which is not an
 * `AuthError` — only a failed credential check is — so re-throwing anything
 * that isn't an `AuthError` lets that redirect actually happen instead of
 * being swallowed here.
 */
export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '').trim()

  if (!email || !password) {
    return { error: 'Enter both an email and a password.' }
  }

  try {
    await signIn('credentials', {
      email,
      password,
      redirectTo: next || '/dashboard',
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: 'Incorrect email or password.' }
    }
    throw err
  }

  return { error: null }
}
