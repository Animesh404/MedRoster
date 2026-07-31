import { expect } from '@playwright/test'
import { login, test } from './fixtures'

/**
 * Light / dark / system, on pages nobody has signed in to.
 *
 * The whole design rests on the server rendering `data-theme` from a cookie
 * before the page is sent, so there is no flash and no blocking script. That
 * is only checkable in a browser: a unit test can assert the component sets a
 * cookie, but not that the NEXT server render honours it, and the gap between
 * those two is exactly where a theme toggle goes wrong.
 */

const COOKIE = 'medroster.theme'

async function themeAttr(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'))
}

/** The rendered background, which is what proves the CSS variables switched
 *  rather than just the attribute changing. */
async function background(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

test.describe('theme toggle, signed out', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies()
  })

  test('is reachable on the marketing page and on login', async ({ page }) => {
    for (const path of ['/', '/login']) {
      await page.goto(path)
      await expect(
        page.getByRole('button', { name: /theme/i }),
        `theme toggle missing on ${path}`,
      ).toBeVisible()
    }
  })

  test('defaults to following the OS', async ({ page }) => {
    await page.goto('/')
    expect(await themeAttr(page)).toBe('system')
  })

  test('picking dark changes the rendered colours, not just the attribute', async ({ page }) => {
    await page.goto('/')
    const before = await background(page)

    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()

    await expect.poll(() => themeAttr(page)).toBe('dark')
    expect(await background(page)).not.toBe(before)
  })

  /**
   * The point of the cookie. A choice that survives only in the DOM is lost on
   * the first full page load, which is the moment somebody notices.
   */
  test('survives a full page load, rendered by the server', async ({ page, context }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await expect.poll(() => themeAttr(page)).toBe('dark')

    const cookie = (await context.cookies()).find((c) => c.name === COOKIE)
    expect(cookie?.value).toBe('dark')

    // A fresh navigation, so this is the SERVER's answer rather than anything
    // left over in the page.
    await page.goto('/login')
    expect(await themeAttr(page)).toBe('dark')
  })

  test('can be put back to following the OS', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await expect.poll(() => themeAttr(page)).toBe('dark')

    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'System' }).click()
    await expect.poll(() => themeAttr(page)).toBe('system')
  })

  /**
   * `system` has to be a real stored value, not the absence of one — otherwise
   * "follow my OS" and "never chose" are the same state, and somebody who
   * deliberately went back to following their OS gets re-pinned by whatever
   * writes a default next.
   */
  test('system is stored explicitly, not left as an empty cookie', async ({ page, context }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'System' }).click()

    await expect
      .poll(async () => (await context.cookies()).find((c) => c.name === COOKIE)?.value)
      .toBe('system')
  })

  test('an unrecognised cookie value falls back rather than breaking', async ({ page, context }) => {
    await context.addCookies([
      { name: COOKIE, value: 'chartreuse', domain: 'localhost', path: '/' },
    ])
    await page.goto('/')

    expect(await themeAttr(page)).toBe('system')
  })
})

const NURSE_EMAIL = 'ivy.bell@clinicmail.test'
const PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

/**
 * The signed-in half, and the only thing that justifies storing a preference on
 * the account at all.
 *
 * A cookie is per-browser. Without the account column, somebody who chose dark
 * at work would be handed a white screen at home — so the test that matters is
 * not "does it save", it is "does it come back on a browser that has never seen
 * this person before".
 */
test.describe('theme preference, signed in', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies()
  })

  test('the toggle is in the app chrome too', async ({ page }) => {
    await login(page, NURSE_EMAIL, PASSWORD)
    await expect(page.getByRole('button', { name: /theme/i })).toBeVisible()
  })

  test('follows the member to a browser that has never seen them', async ({ page, context }) => {
    await login(page, NURSE_EMAIL, PASSWORD)

    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'Dark' }).click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('dark')

    // Everything this browser knows is now gone — cookie included. This is the
    // new-device case, and only the stored preference can survive it.
    await context.clearCookies()
    await page.goto('/login')
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('system')

    await login(page, NURSE_EMAIL, PASSWORD)
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('dark')
  })

  /**
   * Sign-in must not overwrite a choice made seconds earlier on the login page
   * itself with one saved months ago.
   */
  test('does not overwrite a choice made just before signing in', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /theme/i }).click()
    await page.getByRole('menuitem', { name: 'Light' }).click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light')

    await login(page, NURSE_EMAIL, PASSWORD)

    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light')
  })
})

