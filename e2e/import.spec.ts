import path from 'node:path'
import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

const STAFF_CSV_PATH = path.resolve(__dirname, '..', 'staff.csv')

test.describe('CSV import', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await page.goto('/import')
  })

  test('uploading staff.csv reports 34 accepted / 3 merged / 4 rejected of 41, and the Janitor row explains itself', async ({ page, capture }) => {
    await page.setInputFiles('input[type="file"]', STAFF_CSV_PATH)
    await page.getByRole('button', { name: 'Run import' }).click()
    await page.waitForURL(/\/import\/\d+$/, { timeout: 15_000 })

    // The report distinguishes clean ACCEPTED rows from REPAIRED ones (an
    // accepted row with an automatic fix applied) — both are "accepted" in
    // the brief's everyday sense (they became a staff user), so 34 is their
    // SUM (verified directly against the DB before writing this test: 5
    // clean + 29 repaired = 34 users, matching `tests/import/apply.test.ts`'s
    // own `user.count() === 34` assertion), plus 3 merged and 4 rejected of 41.
    const outcomeBar = page.getByRole('img', { name: /Accepted:/ })
    const label = (await outcomeBar.getAttribute('aria-label')) ?? ''
    // The aria-label is the assertion target, so a missing one must fail loudly
    // here rather than silently parsing to an empty count map below.
    expect(label, 'outcome bar has no aria-label to assert on').not.toBe('')
    const counts = Object.fromEntries(
      label.split(', ').map((part) => {
        const [name, rest] = part.split(': ')
        return [name, Number((rest ?? '').split(' of ')[0])]
      }),
    ) as Record<'Accepted' | 'Repaired' | 'Merged' | 'Rejected', number>
    expect(counts.Accepted + counts.Repaired, `expected 34 accepted+repaired, got ${label}`).toBe(34)
    expect(counts.Merged, label).toBe(3)
    expect(counts.Rejected, label).toBe(4)
    expect(counts.Accepted + counts.Repaired + counts.Merged + counts.Rejected).toBe(41)

    // Filter to the 4 rejected rows and find the Janitor one.
    await page.getByRole('link', { name: /Rejected/ }).click()
    await page.waitForURL(/outcome=REJECTED/)

    const janitorRow = page.getByRole('row', { name: /Janitor/ })
    await expect(janitorRow).toBeVisible()
    await expect(janitorRow).toContainText('"Janitor" is not a profession this clinic schedules.')

    assertClean(capture)
  })

  test('uploading an empty file shows a clean inline error, not a crash', async ({ page, capture }) => {
    await page.setInputFiles('input[type="file"]', {
      name: 'empty.csv',
      mimeType: 'text/csv',
      buffer: Buffer.alloc(0),
    })
    await page.getByRole('button', { name: 'Run import' }).click()

    await expect(page.locator('p[role="alert"]')).toBeVisible()
    await expect(page).toHaveURL('/import')

    assertClean(capture, { allowRequests: [/\/api\/imports\b/] })
  })

  test('uploading a binary file shows a clean inline error, not a crash', async ({ page, capture }) => {
    // A small, deliberately non-UTF8, non-CSV blob (PNG magic bytes + noise).
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ])
    await page.setInputFiles('input[type="file"]', {
      name: 'photo.png',
      mimeType: 'application/octet-stream',
      buffer: binary,
    })
    await page.getByRole('button', { name: 'Run import' }).click()

    await expect(page.locator('p[role="alert"]')).toBeVisible()
    await expect(page).toHaveURL('/import')

    assertClean(capture, { allowRequests: [/\/api\/imports\b/] })
  })
})
