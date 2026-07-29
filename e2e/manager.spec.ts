import { test, expect, assertClean, login, staffingSection, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

/**
 * Real seeded fixtures used below (queried directly against `medroster-db-1`
 * before writing this file), all confirmed to fall OUTSIDE the seed's own
 * date range (2026-08-03 .. 2027-10-02), so nothing here can collide with an
 * overlap/role-full check against real seeded claims:
 *
 *  - #22 (2026-08-08 08:00-16:00): DOCTOR requires 1, 0 claimed — an open
 *    slot to assign into and remove from without touching seeded claims.
 *  - #73 (2026-08-22 13:00-21:00): NURSE requires 3, held by Tara Rossi
 *    (id 18) and Anya Haddad (id 33) — used for the "remove an existing
 *    claim" flow, restored via re-assign at the end.
 */
const OPEN_DOCTOR_SHIFT = 22
const EXISTING_NURSE_CLAIM_SHIFT = 73
const EXISTING_NURSE_NAME = 'Anya Haddad'

test.describe('manager flows', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
  })

  test('manager can assign a staff member to a shift, and remove the assignment', async ({ page, capture }) => {
    await page.goto(`/shifts/${OPEN_DOCTOR_SHIFT}`)

    const doctorCombo = page.getByRole('combobox', { name: /assign a doctor/i })
    // #22 needs both a doctor and a nurse, so each row has its own "Assign"
    // button — scope to this row's own control, not the page-wide button.
    const doctorRow = doctorCombo.locator('xpath=..')
    await doctorCombo.click()
    const firstOption = page.getByRole('option').first()
    const assignedName = (await firstOption.textContent())?.trim() ?? ''
    await firstOption.click()
    // Wait for the select's own value to reflect the pick before clicking
    // Assign — clicking immediately after can race base-ui's state commit
    // and hit the button while it's still disabled.
    await expect(doctorCombo).toContainText(assignedName)

    await doctorRow.getByRole('button', { name: 'Assign' }).click()
    const staffing = staffingSection(page)
    await expect(staffing.locator('li').filter({ hasText: assignedName })).toBeVisible({ timeout: 3_000 })

    // Restore: remove the assignment we just made.
    await page.getByRole('button', { name: `Remove ${assignedName} from this shift` }).click()
    await expect(staffing.locator('li').filter({ hasText: assignedName })).toHaveCount(0, { timeout: 3_000 })

    assertClean(capture)
  })

  test('manager can remove an existing claim from a shift', async ({ page, capture }) => {
    await page.goto(`/shifts/${EXISTING_NURSE_CLAIM_SHIFT}`)
    const staffing = staffingSection(page)
    await expect(staffing.locator('li').filter({ hasText: EXISTING_NURSE_NAME })).toBeVisible()

    await page.getByRole('button', { name: `Remove ${EXISTING_NURSE_NAME} from this shift` }).click()
    await expect(staffing.locator('li').filter({ hasText: EXISTING_NURSE_NAME })).toHaveCount(0, { timeout: 3_000 })

    // Restore: re-assign the same nurse so the fixture is unchanged for any
    // later run (including this same suite, re-run). #73 also needs a
    // doctor, so scope to the nurse row's own "Assign" button.
    const nurseCombo = page.getByRole('combobox', { name: /assign a nurse/i })
    const nurseRow = nurseCombo.locator('xpath=..')
    await nurseCombo.click()
    await page.getByRole('option', { name: EXISTING_NURSE_NAME }).click()
    await expect(nurseCombo).toContainText(EXISTING_NURSE_NAME)
    await nurseRow.getByRole('button', { name: 'Assign' }).click()
    await expect(staffing.locator('li').filter({ hasText: EXISTING_NURSE_NAME })).toBeVisible({ timeout: 3_000 })

    assertClean(capture)
  })

  test('manager can create a one-off shift', async ({ page, capture }) => {
    await page.goto('/shifts/new')

    await page.locator('input[type="date"]').first().fill('2028-02-01')
    await page.locator('input[type="time"]').first().fill('09:00')
    await page.locator('input[type="time"]').nth(1).fill('17:00')

    // "Who's needed": bump receptionist to 1 so the create button enables.
    await page.getByRole('button', { name: /more receptionists required/i }).click()

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/shifts') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create shift' }).click(),
    ])
    expect(response.ok()).toBe(true)
    const body = await response.json() as { ids: number[] }
    expect(body.ids).toHaveLength(1)

    await page.waitForURL(`/shifts/${body.ids[0]}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('1 February 2028')

    // Clean up: delete the shift we just created.
    await page.getByRole('button', { name: 'Delete shift' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Nobody currently holds this shift.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete shift' }).click()
    await page.waitForURL('/dashboard')

    assertClean(capture)
  })

  test('recurring series: the preview count matches what is actually created, then cleans up', async ({ page, capture }) => {
    await page.goto('/shifts/new')

    await page.locator('input[type="date"]').first().fill('2028-01-10') // a Monday
    await page.locator('input[type="time"]').first().fill('08:00')
    await page.locator('input[type="time"]').nth(1).fill('16:00')
    await page.getByRole('button', { name: /more receptionists required/i }).click()

    await page.getByRole('checkbox', { name: 'Repeat this shift' }).click()
    await page.getByRole('button', { name: 'Mon', exact: true }).click()
    // "Until" is the second remaining date input once recurrence is on.
    await page.locator('input[type="date"]').nth(1).fill('2028-01-17') // the following Monday: 2 occurrences

    const previewCount = await page.locator('p.tabular.text-4xl').textContent()
    expect(previewCount?.trim()).toBe('2')

    const createButton = page.getByRole('button', { name: /Create 2 shifts/ })
    await expect(createButton).toBeVisible()

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/shifts') && r.request().method() === 'POST'),
      createButton.click(),
    ])
    expect(response.ok()).toBe(true)
    const body = await response.json() as { ids: number[] }
    expect(body.ids).toHaveLength(2)

    await page.waitForURL('/dashboard')

    // Clean up both occurrences through the real delete flow.
    for (const id of body.ids) {
      await page.goto(`/shifts/${id}`)
      await page.getByRole('button', { name: 'Delete shift' }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Nobody currently holds this shift.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Delete shift' }).click()
      await page.waitForURL('/dashboard')
    }

    assertClean(capture)
  })

  test('editing a shift with claims previews real people and reasons, then deleting it cleans up', async ({ page, capture }) => {
    // Fresh shift, far outside the seed's date range, needing 2 nurses.
    // NewShiftForm defaults NURSE to 1, so a single "more" click reaches 2.
    await page.goto('/shifts/new')
    await page.locator('input[type="date"]').first().fill('2028-03-06')
    await page.locator('input[type="time"]').first().fill('08:00')
    await page.locator('input[type="time"]').nth(1).fill('16:00')
    await page.getByRole('button', { name: /more nurses required/i }).click()

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/shifts') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create shift' }).click(),
    ])
    const { ids } = await createResponse.json() as { ids: number[] }
    const shiftId = ids[0]
    await page.waitForURL(`/shifts/${shiftId}`)

    // Assign two nurses, oldest first: Aisha Sharma, then Aisha Weber.
    const staffing = staffingSection(page)
    const combo = page.getByRole('combobox', { name: /assign a nurse/i })
    await expect(combo).toBeVisible()
    for (const name of ['Aisha Sharma', 'Aisha Weber']) {
      await combo.click()
      await page.getByRole('option', { name }).click()
      // Wait for the select's own value to reflect the pick before clicking
      // Assign — clicking immediately after can race base-ui's state commit
      // and hit the button while it's still disabled (nothing selected yet).
      await expect(combo).toContainText(name)
      await page.getByRole('button', { name: 'Assign' }).click()
      await expect(staffing.locator('li').filter({ hasText: name })).toBeVisible({ timeout: 3_000 })
    }

    // Edit: drop the nurse requirement from 2 to 1 — the newest claim
    // (Aisha Weber) should be the one previewed as dropped.
    await page.getByRole('button', { name: 'Edit shift' }).click()
    const editDialog = page.getByRole('dialog')
    const decreaseNurse = editDialog.getByRole('button', { name: /fewer nurses required/i })
    await decreaseNurse.click()
    await editDialog.getByRole('button', { name: 'Preview changes' }).click()

    await expect(editDialog.locator('p', { hasText: '1 person will lose this shift' })).toBeVisible()
    // The dropped row names the real person AND the server's own reason —
    // never a client-side guess (mirrors the claim-rejection contract).
    const droppedRow = editDialog.locator('li').filter({ hasText: 'Aisha Weber' })
    await expect(droppedRow).toBeVisible()
    await expect(droppedRow).toContainText('This shift already has 1 of 1 nurse.')
    // The claim kept (oldest) is not in the drop list.
    await expect(editDialog.locator('li').filter({ hasText: 'Aisha Sharma' })).toHaveCount(0)

    await editDialog.getByRole('button', { name: 'Confirm changes' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 3_000 })
    await expect(staffing.locator('li').filter({ hasText: 'Aisha Weber' })).toHaveCount(0)
    await expect(staffing.locator('li').filter({ hasText: 'Aisha Sharma' })).toBeVisible()

    // Delete: the one remaining claim (Aisha Sharma) must show in the
    // delete preview before anything is destroyed.
    await page.getByRole('button', { name: 'Delete shift' }).click()
    const deleteDialog = page.getByRole('dialog')
    await expect(deleteDialog.locator('p', { hasText: '1 person currently hold this shift' })).toBeVisible()
    await expect(deleteDialog.locator('li').filter({ hasText: 'Aisha Sharma' })).toBeVisible()
    await deleteDialog.getByRole('button', { name: 'Delete shift' }).click()
    await page.waitForURL('/dashboard')

    assertClean(capture)
  })
})
