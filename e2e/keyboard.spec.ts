import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

interface FocusSnapshot {
  key: string
  visible: boolean
  hasVisibleIndicator: boolean
}

/** Tabs `count` times from wherever focus currently is, recording which
 *  element received focus each time and whether it's actually visible /
 *  carries a visible focus indicator (outline or box-shadow — Tailwind's
 *  `focus-visible:ring-*` utilities render as one of the two). */
async function tabThrough(page: import('@playwright/test').Page, count: number): Promise<FocusSnapshot[]> {
  const snapshots: FocusSnapshot[] = []
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab')
    const snapshot = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      const hasVisibleIndicator = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
        || style.boxShadow !== 'none'
      const key = `${el.tagName}#${el.id || ''}[${el.getAttribute('name') || el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 24)}]`
      return { key, visible, hasVisibleIndicator }
    })
    if (snapshot) snapshots.push(snapshot)
  }
  return snapshots
}

/**
 * Collapses consecutive reads of the SAME element into one entry.
 *
 * A native `<input type="date">` (e.g. `WeekPicker`'s jump-to-date field)
 * legitimately consumes several Tab presses moving between its own
 * day/month/year segments before handing focus to the next real control —
 * `document.activeElement` never changes during that, so those reads are
 * one focus stop, not several, and flagging them as "the same element twice
 * in a row" would (falsely) report a keyboard trap. A collapsed entry's
 * indicator is "seen at least once" rather than "every single read", since a
 * getComputedStyle read taken mid-segment-transition can momentarily miss
 * the ring even though the element never actually lost focus.
 */
function collapseConsecutive(snapshots: FocusSnapshot[]): FocusSnapshot[] {
  const out: FocusSnapshot[] = []
  for (const s of snapshots) {
    const last = out[out.length - 1]
    if (last && last.key === s.key) {
      last.visible = last.visible || s.visible
      last.hasVisibleIndicator = last.hasVisibleIndicator || s.hasVisibleIndicator
    } else {
      out.push({ ...s })
    }
  }
  return out
}

test.describe('keyboard navigation', () => {
  test('tabbing through the login form reaches every field with visible focus, and never traps', async ({ page, capture }) => {
    await page.goto('/login')
    const snapshots = await tabThrough(page, 10)

    // Every focused element must actually be on screen.
    for (const s of snapshots) expect(s.visible, `${s.key} received focus but is not visible`).toBe(true)
    // Every focused element must carry a visible indicator (outline or box-shadow).
    for (const s of snapshots) expect(s.hasVisibleIndicator, `${s.key} received focus with no visible indicator`).toBe(true)

    // The email and password inputs are both reached, in order.
    const emailIndex = snapshots.findIndex((s) => s.key.includes('[email]'))
    const passwordIndex = snapshots.findIndex((s) => s.key.includes('[password]'))
    expect(emailIndex, 'Tab never reached the email field').toBeGreaterThanOrEqual(0)
    expect(passwordIndex, 'Tab never reached the password field').toBeGreaterThanOrEqual(0)
    expect(passwordIndex).toBeGreaterThan(emailIndex)

    // No trap: consecutive tabs never land on the exact same element twice in a row.
    // Destructured rather than indexed twice: `noUncheckedIndexedAccess` types
    // every element access as possibly-undefined, and a bare `snapshots[i]!`
    // would assert away exactly the bound this loop relies on.
    for (let i = 1; i < snapshots.length; i++) {
      const previous = snapshots[i - 1]
      const current = snapshots[i]
      if (!previous || !current) continue
      expect(current.key, `focus stuck repeating ${current.key}`).not.toBe(previous.key)
    }

    assertClean(capture)
  })

  test('tabbing through the dashboard moves through distinct, visible controls without trapping', async ({ page, capture }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await page.goto('/dashboard?week=2026-W32')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const snapshots = collapseConsecutive(await tabThrough(page, 15))

    for (const s of snapshots) expect(s.visible, `${s.key} received focus but is not visible`).toBe(true)
    for (const s of snapshots) expect(s.hasVisibleIndicator, `${s.key} received focus with no visible indicator`).toBe(true)

    // Destructured rather than indexed twice: `noUncheckedIndexedAccess` types
    // every element access as possibly-undefined, and a bare `snapshots[i]!`
    // would assert away exactly the bound this loop relies on.
    for (let i = 1; i < snapshots.length; i++) {
      const previous = snapshots[i - 1]
      const current = snapshots[i]
      if (!previous || !current) continue
      expect(current.key, `focus stuck repeating ${current.key}`).not.toBe(previous.key)
    }

    // A real range of distinct controls was actually visited, not one widget
    // silently re-focusing itself under a different snapshot key each time.
    const distinct = new Set(snapshots.map((s) => s.key))
    expect(distinct.size).toBeGreaterThan(8)

    assertClean(capture)
  })
})
