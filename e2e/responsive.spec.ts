import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]

test.describe('responsive dashboard', () => {
  test('no horizontal overflow at 1440/768/390, and missing-roles text survives at 390', async ({ page, capture }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    // A week with a real mix of full/partial/empty shifts (seeded, verified
    // directly against the DB before writing this test).
    await page.goto('/dashboard?week=2026-W32')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport)
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(
        overflow.scrollWidth,
        `horizontal overflow at ${viewport.width}px: scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`,
      ).toBeLessThanOrEqual(overflow.innerWidth)
    }

    // Still at 390 (the last viewport applied above): the missing-roles
    // caption on a not-fully-staffed shift card must render non-empty text,
    // not get silently clipped/hidden at the narrowest breakpoint.
    const captions = page.locator('article p.text-xs.text-muted-foreground')
    const count = await captions.count()
    expect(count).toBeGreaterThan(0)

    let sawNonEmptyMissingRoles = false
    for (let i = 0; i < count; i++) {
      const text = (await captions.nth(i).textContent())?.trim() ?? ''
      if (text && text !== 'Fully staffed') {
        sawNonEmptyMissingRoles = true
        expect(text.length).toBeGreaterThan(0)
      }
    }
    expect(sawNonEmptyMissingRoles, 'expected at least one shift card with non-empty missing-roles text at 390px').toBe(true)

    assertClean(capture)
  })
})

/**
 * The footer wordmark, at every width somebody might actually use.
 *
 * It was `text-[18vw] sm:text-[12rem]` and clipped at both ends: ~45px over on
 * a phone, and 418px over on a 768px tablet, where the fixed 12rem takes effect
 * regardless of how narrow the screen is. `overflow-x-hidden` on the footer
 * contains horizontal bleed without shaving the bottom off the glyphs — the
 * old `overflow-hidden` plus `-mb-8` did that on phones.
 *
 * Two assertions, because the obvious one alone is satisfiable by a bug: a
 * wordmark that collapsed to the 16px body default would also measure as "not
 * clipped", while looking nothing like the design. A dropped or mistyped
 * Tailwind class does exactly that, silently, in a passing build.
 */
test.describe('footer wordmark', () => {
  for (const width of [320, 390, 414, 768, 1024, 1440]) {
    test(`is neither clipped nor collapsed at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')

      const metrics = await page.evaluate(() => {
        const el = [...document.querySelectorAll('footer p')]
          .find((p) => p.textContent?.trim() === 'MEDROSTER')
        if (!el) throw new Error('footer wordmark not found')
        const footer = el.closest('footer')
        if (!footer) throw new Error('footer not found')
        const elRect = el.getBoundingClientRect()
        const footerRect = footer.getBoundingClientRect()
        return {
          fontSize: parseFloat(getComputedStyle(el).fontSize),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          bottomGap: footerRect.bottom - elRect.bottom,
        }
      })

      // Not clipped horizontally.
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
      // Nor vertically — the glyph box must sit inside the footer, with a
      // little padding for safe-area/home-indicator breathing room.
      expect(metrics.bottomGap).toBeGreaterThanOrEqual(0)
      // And still a display wordmark, not the 16px body default a dropped
      // Tailwind class silently leaves behind. An absolute floor rather than a
      // fraction of the viewport: the size is capped at 14rem, so a
      // proportional check would fail on a wide screen for a correct value.
      expect(metrics.fontSize).toBeGreaterThan(40)
    })
  }
})

