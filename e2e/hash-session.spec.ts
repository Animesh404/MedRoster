import { expect } from '@playwright/test'
import { test } from './fixtures'

/**
 * The fragment sign-in path, driven in a real browser.
 *
 * This exists because a whole class of link cannot be tested any other way. On
 * a project that cannot install custom email templates — Supabase refuses them
 * on the free tier with the built-in mailer — invites, magic links and password
 * resets all come back as:
 *
 *   https://app/auth/reset-password#access_token=…&refresh_token=…&type=recovery
 *
 * A fragment is never sent to the server, so no server-side test can observe
 * this at all: a request-level assertion sees a bare URL and cannot tell a
 * working link from a broken one. Only a browser can.
 *
 * Tokens are minted by signing in through the auth API rather than by reading
 * an email, which keeps the test independent of whichever mailer is configured.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321'
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
const NURSE_EMAIL = 'ivy.bell@clinicmail.test'
const PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

async function mintTokens(): Promise<{ access: string; refresh: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: NURSE_EMAIL, password: PASSWORD }),
  })
  const body = await res.json() as { access_token?: string; refresh_token?: string }
  if (!body.access_token || !body.refresh_token) {
    throw new Error(`could not mint tokens: ${JSON.stringify(body).slice(0, 200)}`)
  }
  return { access: body.access_token, refresh: body.refresh_token }
}

test.describe('session handed over in the URL fragment', () => {
  test('a recovery link with tokens in the fragment reaches the password form', async ({ page }) => {
    const { access, refresh } = await mintTokens()

    await page.goto(
      `/auth/reset-password#access_token=${access}&refresh_token=${refresh}&type=recovery`,
    )

    // The server render could not see the fragment, so it rendered the
    // signed-out branch. The bridge exchanges and refreshes into this one.
    await expect(page.getByRole('heading', { name: /choose a new password/i })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText(/no longer valid/i)).toHaveCount(0)
  })

  /**
   * The tokens must not survive in the address bar. Left there they sit in
   * browser history, are replayable by a refresh, and leak through `Referer`
   * to anything the page later requests.
   */
  test('spends the tokens and strips them from the URL', async ({ page }) => {
    const { access, refresh } = await mintTokens()

    await page.goto(
      `/auth/reset-password#access_token=${access}&refresh_token=${refresh}&type=recovery`,
    )
    await expect(page.getByRole('heading', { name: /choose a new password/i })).toBeVisible({
      timeout: 10_000,
    })

    expect(await page.evaluate(() => window.location.hash)).toBe('')
    expect(page.url()).not.toContain('access_token')
  })

  test('an expired link leaves the page saying so, rather than hanging', async ({ page }) => {
    await page.goto(
      '/auth/reset-password#error=access_denied&error_description=Email+link+is+invalid+or+has+expired',
    )

    await expect(page.getByText(/no longer valid/i)).toBeVisible({ timeout: 10_000 })
    // Cleared even on the failure path — an error fragment is still noise that
    // a refresh would re-process.
    expect(await page.evaluate(() => window.location.hash)).toBe('')
  })

  test('magic-link landing page signs the member in and moves them on', async ({ page }) => {
    const { access, refresh } = await mintTokens()

    await page.goto(
      `/auth/complete#access_token=${access}&refresh_token=${refresh}&type=magiclink`,
    )

    await page.waitForURL('**/dashboard', { timeout: 15_000 })
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
