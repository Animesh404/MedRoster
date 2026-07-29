import { test as base, expect, type Page } from '@playwright/test'

/**
 * Shared browser-stress harness. Every spec in this directory drives the
 * REAL, already-installed Chrome against a running Next server (see
 * playwright.config.ts's `channel: 'chrome'`) — this file exists so every
 * spec captures console errors/warnings, uncaught page errors, and
 * unexpected failed network requests the same way, instead of each spec
 * wiring its own listeners.
 */

export interface ConsoleCapture {
  errors: string[]
  warnings: string[]
  pageErrors: string[]
  failedRequests: string[]
}

type Fixtures = {
  capture: ConsoleCapture
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  capture: async ({ page }, use) => {
    const capture: ConsoleCapture = { errors: [], warnings: [], pageErrors: [], failedRequests: [] }

    page.on('console', (msg) => {
      const type = msg.type()
      const text = msg.text()
      // Chrome itself emits this exact diagnostic for ANY failed resource
      // load (a 404 page, a deliberately-provoked 409 from a business-rule
      // test, ...) — it's the browser's own network log, not something the
      // app's code called `console.error` with, and it's already captured
      // with full method/URL/status precision by the `response` listener
      // below (`failedRequests`), which every test asserts on directly.
      // Keeping it out of `errors` avoids every business-rule-rejection test
      // having to whitelist it by hand while still catching a REAL
      // `console.error` the app or React itself emits.
      if (type === 'error' && /^Failed to load resource: the server responded with a status of \d+/.test(text)) return
      if (type === 'error') capture.errors.push(`[console.error] ${text}`)
      if (type === 'warning') capture.warnings.push(`[console.warning] ${text}`)
    })
    page.on('pageerror', (err) => {
      capture.pageErrors.push(err.message)
    })
    page.on('response', (res) => {
      const status = res.status()
      if (status >= 400) {
        capture.failedRequests.push(`${res.request().method()} ${res.url()} -> ${status}`)
      }
    })

    await use(capture)
  },
})

export { expect }

/**
 * Asserts the capture is clean: zero console errors, zero console warnings,
 * zero uncaught exceptions, zero UNEXPECTED failed network requests.
 *
 * `allowRequests` whitelists failed requests a test deliberately provoked as
 * part of exercising a real business rule (e.g. a 409 from claiming a
 * role-full shift) — those are correct server behaviour, not bugs, and are
 * asserted on directly by the test via the response body/DOM text instead.
 */
export function assertClean(
  capture: ConsoleCapture,
  opts?: { allowRequests?: RegExp[]; allowConsoleErrors?: RegExp[] },
): void {
  const unexpectedRequests = opts?.allowRequests
    ? capture.failedRequests.filter((r) => !opts.allowRequests!.some((re) => re.test(r)))
    : capture.failedRequests
  // Chrome itself logs "Failed to load resource: ... 404" for the main-frame
  // document whenever a navigation legitimately 404s (Next's own not-found
  // page) — a browser diagnostic, not something the app's own code emitted.
  // Only whitelisted when a test explicitly expects a 404 navigation.
  const unexpectedErrors = opts?.allowConsoleErrors
    ? capture.errors.filter((e) => !opts.allowConsoleErrors!.some((re) => re.test(e)))
    : capture.errors

  expect(unexpectedErrors, `console errors:\n${unexpectedErrors.join('\n')}`).toEqual([])
  expect(capture.warnings, `console warnings:\n${capture.warnings.join('\n')}`).toEqual([])
  expect(capture.pageErrors, `uncaught exceptions:\n${capture.pageErrors.join('\n')}`).toEqual([])
  expect(unexpectedRequests, `unexpected failed requests:\n${unexpectedRequests.join('\n')}`).toEqual([])
}

export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'
export const MANAGER_EMAIL = 'manager@clinicmail.test'
export const NURSE_EMAIL = 'ivy.bell@clinicmail.test'

/** Logs in through the real form (exercises the Auth.js credentials path),
 *  waiting for the post-login redirect rather than a fixed timeout. */
export async function login(page: Page, email: string, password: string, next?: string): Promise<void> {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(next ?? '/dashboard')
}

/**
 * The shift detail page's "Staffing by role" section — scoping holder-name
 * assertions to this (rather than the whole page) matters because a name
 * that just left the holders list can still legitimately appear in the
 * Activity timeline below it (e.g. "X released this shift."), which would
 * otherwise make a naive page-wide `toHaveCount(0)` check flaky/wrong.
 */
export function staffingSection(page: Page) {
  return page.locator('section', { has: page.getByRole('heading', { name: 'Staffing by role' }) })
}

export async function logout(page: Page): Promise<void> {
  await page.locator('[data-slot="dropdown-menu-trigger"]').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL('/login')
}
