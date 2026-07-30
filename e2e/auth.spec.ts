import { test, expect, assertClean, login, logout, SEED_PASSWORD, MANAGER_EMAIL, NURSE_EMAIL } from './fixtures'

test.describe('auth', () => {
  test('manager can log in through the real form and reach the dashboard', async ({ page, capture }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    assertClean(capture)
  })

  test('manager can log out', async ({ page, capture }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await logout(page)
    await expect(page).toHaveURL('/login')
    assertClean(capture)
  })

  test('nurse can log in through the real form', async ({ page, capture }) => {
    await login(page, NURSE_EMAIL, SEED_PASSWORD)
    await expect(page).toHaveURL('/dashboard')
    assertClean(capture)
  })

  test('wrong password shows an inline error, not a crash', async ({ page, capture }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(MANAGER_EMAIL)
    await page.getByLabel('Password').fill('definitely-not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Scoped to the actual error paragraph — Next.js's own route announcer
    // (`#__next-route-announcer__`) also carries `role="alert"`.
    await expect(page.locator('p[role="alert"]')).toHaveText('Incorrect email or password.')
    await expect(page).toHaveURL(/\/login/)
    assertClean(capture)
  })

  test('nurse visiting a manager-only URL gets a clean 404, not a crash', async ({ page, capture }) => {
    await login(page, NURSE_EMAIL, SEED_PASSWORD)

    await page.goto('/shifts/new')
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible()

    await page.goto('/import')
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible()

    // 404s are the intended, documented behaviour for a staff member hitting
    // a manager-only route (defence in depth on top of the hidden nav link)
    // — not an unexpected failed request.
    assertClean(capture, { allowRequests: [/\/shifts\/new/, /\/import/] })
  })

  test('unauthenticated visit to a protected route redirects to login', async ({ page, capture }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
    assertClean(capture)
  })

  test('an off-origin next param is ignored, not followed after a real sign-in', async ({ page, capture }) => {
    await page.goto(`/login?next=${encodeURIComponent('https://evil.example/')}`)
    await page.getByLabel('Email').fill(MANAGER_EMAIL)
    await page.getByLabel('Password').fill(SEED_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL('/dashboard')
    assertClean(capture)
  })
})
