import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

test.describe('week navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
  })

  test('deep link straight to a specific ISO week renders that week', async ({ page, capture }) => {
    await page.goto('/dashboard?week=2026-W33')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('10 August')
    assertClean(capture)
  })

  test('stepping forward and back across a year boundary (2026-W53 <-> 2027-W01)', async ({ page, capture }) => {
    await page.goto('/dashboard?week=2026-W53')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('28 December')

    await page.getByRole('button', { name: /Next/ }).click()
    await page.waitForURL(/week=2027-W01/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('4 January')

    await page.getByRole('button', { name: /Previous/ }).click()
    await page.waitForURL(/week=2026-W53/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('28 December')

    assertClean(capture)
  })

  test('browser back/forward follows the URL, and the rendered week follows it', async ({ page, capture }) => {
    await page.goto('/dashboard?week=2026-W33')
    await page.getByRole('button', { name: /Next/ }).click()
    await page.waitForURL(/week=2026-W34/)

    await page.goBack()
    await expect(page).toHaveURL(/week=2026-W33/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('10 August')

    await page.goForward()
    await expect(page).toHaveURL(/week=2026-W34/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('17 August')

    assertClean(capture)
  })

  test('the date jump input navigates to the week containing the chosen date', async ({ page, capture }) => {
    await page.goto('/dashboard?week=2026-W33')
    await page.locator('input[type="date"]').fill('2026-09-15')
    await page.waitForURL(/week=2026-W38/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('14 September')

    assertClean(capture)
  })

  test('an invalid but shape-valid ISO week degrades gracefully, not with a crash', async ({ page, capture }) => {
    await page.goto('/dashboard?week=2025-W53') // 2025 has no week 53
    // The component renders a typographic apostrophe (’ U+2019), not '.
    await expect(page.getByRole('heading', { name: /That week doesn.t exist/ })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to the current week' })).toBeVisible()

    assertClean(capture)
  })
})
