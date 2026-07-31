/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LoginForm } from '@/app/login/login-form'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signInWithPassword: vi.fn(),
      signInWithOtp: vi.fn(),
      signInWithOAuth: vi.fn(),
    },
  }),
}))

describe('LoginForm', () => {
  it('offers password sign-in', () => {
    render(<LoginForm demoPassword="medroster123" />)
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
  })

  /**
   * Google sign-in is deferred (see DECISIONS.md), and this is what keeps the
   * button from drifting back.
   *
   * It is not a style preference. The provider is not enabled on the Supabase
   * project, so the button that used to sit here returned a 400 from
   * `/auth/v1/authorize` the moment anybody clicked it — an advertised way in
   * that let nobody in. Re-adding it before the provider is configured, and
   * before the identity-linking question in DECISIONS.md is answered, puts that
   * broken door straight back on the login page.
   */
  it('offers no Google sign-in while the provider is disabled', () => {
    render(<LoginForm demoPassword="medroster123" />)

    expect(screen.queryByRole('button', { name: /google/i })).toBeNull()
    expect(screen.queryByText(/continue with google/i)).toBeNull()
  })

  it('still offers the magic-link route, which is enabled', () => {
    render(<LoginForm demoPassword="medroster123" />)
    expect(screen.getByRole('button', { name: /sign-in link/i })).toBeInTheDocument()
  })
})
