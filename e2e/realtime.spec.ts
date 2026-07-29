import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL, NURSE_EMAIL } from './fixtures'

/**
 * #21 (2026-08-08 21:00-05:00, in week 2026-W32): NURSE requires 1, 0
 * claimed at the time this file was written — a real free slot, not test
 * setup bypassing `assignClaim`.
 *
 * Locally there is no Supabase Realtime (`NEXT_PUBLIC_SUPABASE_URL` unset —
 * see the .env note in the stress-pass report), so `useRealtimeWeek` degrades
 * to its documented 4s-poll fallback. This spec allows up to 8s per
 * assertion for that reason, not a fixed sleep.
 */
const SHIFT_ID = 21
const WEEK = '2026-W32'

test.describe('two-tab realtime', () => {
  test('a claim made in one tab appears in another tab without a reload', async ({ browser, capture }) => {
    const managerContext = await browser.newContext()
    const nurseContext = await browser.newContext()

    try {
      const managerPage = await managerContext.newPage()
      const nursePage = await nurseContext.newPage()

      managerPage.on('console', (m) => { if (m.type() === 'error') capture.errors.push(`[manager tab] ${m.text()}`) })
      managerPage.on('pageerror', (e) => capture.pageErrors.push(`[manager tab] ${e.message}`))
      nursePage.on('console', (m) => { if (m.type() === 'error') capture.errors.push(`[nurse tab] ${m.text()}`) })
      nursePage.on('pageerror', (e) => capture.pageErrors.push(`[nurse tab] ${e.message}`))

      await login(managerPage, MANAGER_EMAIL, SEED_PASSWORD)
      await managerPage.goto(`/dashboard?week=${WEEK}`)
      const card = managerPage.locator('article', { has: managerPage.locator(`a[href="/shifts/${SHIFT_ID}"]`) })
      await expect(card).toContainText('Needs 1 nurse')

      await login(nursePage, NURSE_EMAIL, SEED_PASSWORD)
      await nursePage.goto(`/shifts/${SHIFT_ID}`)
      await nursePage.getByRole('button', { name: 'Claim shift' }).click()
      await expect(nursePage.getByRole('button', { name: 'Release shift' })).toBeVisible({ timeout: 3_000 })

      // The manager's tab, still open on the dashboard, must pick this up on
      // its own — no navigation, no reload — via the polling fallback.
      await expect(card).toContainText('Fully staffed', { timeout: 8_000 })

      // Release it back, and confirm the manager's tab reverts the same way
      // — restores the fixture AND proves the live update works both ways.
      await nursePage.getByRole('button', { name: 'Release shift' }).click()
      await expect(nursePage.getByRole('button', { name: 'Claim shift' })).toBeVisible({ timeout: 3_000 })
      await expect(card).toContainText('Needs 1 nurse', { timeout: 8_000 })

      assertClean(capture)
    } finally {
      await managerContext.close()
      await nurseContext.close()
    }
  })
})
