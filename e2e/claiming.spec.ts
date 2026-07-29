import { test, expect, assertClean, login, SEED_PASSWORD, NURSE_EMAIL } from './fixtures'

/**
 * Fixture shift ids below are real seeded data (see prisma/seed.ts +
 * shifts.csv/staff.csv import), queried directly against the running
 * `medroster-db-1` before writing this file:
 *
 *  - #21 (2026-08-08 21:00-05:00): NURSE requires 1, 0 claimed, ivy.bell has
 *    no claim here and no overlapping claim either — a clean free-slot claim.
 *  - #14 (2026-08-06 07:00-15:00): NURSE requires 2, already 2 claimed by
 *    OTHER nurses, ivy.bell has no claim here — role-full rejection.
 *  - #74 (2026-08-22 07:00-15:00): ivy.bell already holds this as NURSE.
 *  - #73 (2026-08-22 13:00-21:00): NURSE requires 3, 2 claimed, ivy.bell has
 *    no claim here, but it overlaps #74's window — overlap rejection with a
 *    free role slot, so the rejection is unambiguously about the overlap.
 */
const FREE_SLOT_SHIFT = 21
const ROLE_FULL_SHIFT = 14
const OVERLAP_SHIFT = 73

test.describe('optimistic claiming', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, NURSE_EMAIL, SEED_PASSWORD)
  })

  test('claim on a free slot flips the button immediately, before the network settles', async ({ page, capture }) => {
    await page.goto(`/shifts/${FREE_SLOT_SHIFT}`)
    const claimButton = page.getByRole('button', { name: 'Claim shift' })
    await expect(claimButton).toBeVisible()

    // Slow the claim request down so the pre-network-settle flip is actually
    // observable rather than racing a fast localhost round trip.
    await page.route('**/api/shifts/*/claims', async (route) => {
      await new Promise((r) => setTimeout(r, 800))
      await route.continue()
    })

    await claimButton.click()
    // Flips to "Release shift" BEFORE the artificially delayed request settles.
    await expect(page.getByRole('button', { name: 'Release shift' })).toBeVisible({ timeout: 300 })

    // Let the real request land, then confirm it stuck (not a rollback).
    await expect(page.getByRole('button', { name: 'Release shift' })).toBeVisible({ timeout: 2_000 })
    await expect(page.locator('p[role="alert"]')).toHaveCount(0)

    // Clean up: release it so this fixture is claim-free for the next run.
    await page.unroute('**/api/shifts/*/claims')
    await page.getByRole('button', { name: 'Release shift' }).click()
    await expect(page.getByRole('button', { name: 'Claim shift' })).toBeVisible({ timeout: 2_000 })

    assertClean(capture)
  })

  test('claiming a role-full shift flips then rolls back with the real server message', async ({ page, capture }) => {
    await page.goto(`/shifts/${ROLE_FULL_SHIFT}`)
    const claimButton = page.getByRole('button', { name: 'Claim shift' })
    await expect(claimButton).toBeVisible()

    await claimButton.click()
    // Rolls back to "Claim shift" once the server rejects it.
    await expect(page.getByRole('button', { name: 'Claim shift' })).toBeVisible({ timeout: 3_000 })

    const alert = page.locator('p[role="alert"]')
    await expect(alert).toBeVisible()
    // #14's real seeded state: 2 nurses required, 2 already claimed — the
    // server's own message, verbatim (not a client-side guess).
    await expect(alert).toContainText('This shift already has 2 of 2 nurses.')

    assertClean(capture, { allowRequests: [/\/api\/shifts\/\d+\/claims/] })
  })

  test('claiming a shift that overlaps one already held rolls back naming the conflict', async ({ page, capture }) => {
    await page.goto(`/shifts/${OVERLAP_SHIFT}`)
    const claimButton = page.getByRole('button', { name: 'Claim shift' })
    await expect(claimButton).toBeVisible()

    await claimButton.click()
    await expect(page.getByRole('button', { name: 'Claim shift' })).toBeVisible({ timeout: 3_000 })

    const alert = page.locator('p[role="alert"]')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Overlaps a shift you already hold')
    // Names the conflicting shift's own time (#74, 08:00-16:00 Europe/London
    // on 22 Aug), not just a generic "overlaps something".
    await expect(alert).toContainText('22 Aug')
    await expect(alert).toContainText('08:00')

    assertClean(capture, { allowRequests: [/\/api\/shifts\/\d+\/claims/] })
  })

  test('releasing a shift removes it from My Shifts without a manual reload', async ({ page, capture }) => {
    // Claim it first (real claim, not test setup bypassing assignClaim).
    await page.goto(`/shifts/${FREE_SLOT_SHIFT}`)
    await page.getByRole('button', { name: 'Claim shift' }).click()
    await expect(page.getByRole('button', { name: 'Release shift' })).toBeVisible({ timeout: 2_000 })

    await page.goto('/my-shifts')
    const row = page.locator('li', { has: page.locator(`a[href="/shifts/${FREE_SLOT_SHIFT}"]`) })
    await expect(row).toBeVisible()

    await row.getByRole('button', { name: 'Release shift' }).click()
    await expect(row).toHaveCount(0, { timeout: 3_000 })

    assertClean(capture)
  })
})
