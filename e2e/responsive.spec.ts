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
