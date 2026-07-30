import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL, NURSE_EMAIL } from './fixtures'

const MAILPIT = 'http://127.0.0.1:54324'

/** Newest message sent to `address`, via Mailpit's HTTP API. Mailpit's
 *  search endpoint only returns a truncated plaintext snippet (not enough to
 *  extract a full link from), so this makes a second call for the full
 *  message body once the id is known. */
async function latestMessageTo(request: import('@playwright/test').APIRequestContext, address: string) {
  const list = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:' + address)}`)
  const body = await list.json()
  expect(body.messages?.length, `no invite email arrived for ${address}`).toBeGreaterThan(0)
  const full = await request.get(`${MAILPIT}/api/v1/message/${body.messages[0].ID}`)
  return await full.json()
}

test.describe('member invites', () => {
  test('a manager invites someone, who accepts the emailed link and signs in', async ({ page, request, capture, baseURL }) => {
    // Unique per run: Supabase keeps auth users between runs, and a repeat
    // address returns `email_exists` and sends nothing.
    const address = `invitee-${Date.now()}@clinicmail.test`

    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await page.goto('/members')

    await page.getByLabel('Email').fill(address)
    await page.getByLabel('Name').fill('Invited Person')
    await page.getByRole('button', { name: 'Send invite' }).click()

    // Scoped to this invitee's own row: prior runs of this same spec leave
    // their own (differently-addressed) "Invited" rows behind — Supabase
    // and the roster both persist between runs (note the unique address
    // above) — so a page-wide "Invited" text match is ambiguous the moment
    // this test has ever run before.
    const inviteeRow = page.getByRole('row', { name: address })
    await expect(inviteeRow).toBeVisible()
    await expect(inviteeRow.getByText('Invited', { exact: true })).toBeVisible()

    const message = await latestMessageTo(request, address)
    const link = (message.Text as string).match(/https?:\/\/\S+/)?.[0]
    expect(link, 'invite email contained no link').toBeTruthy()

    // The invite template hardcodes GoTrue's configured `site_url`
    // (supabase/config.toml, pinned to :3000 for the `npm run dev` default)
    // as the link's origin — it has no way to know which port THIS e2e run's
    // production server is actually bound to (:3100, per this suite's
    // convention of not colliding with a dev server). Only the path and
    // query (token_hash/type/next) are meaningful; re-host those onto the
    // server actually under test rather than the literal emailed origin.
    const emailedUrl = new URL(link!)
    const acceptUrl = new URL(emailedUrl.pathname + emailedUrl.search, baseURL).toString()

    // A fresh context: the invitee is not the manager who invited them.
    const invitee = await page.context().browser()!.newContext()
    const inviteePage = await invitee.newPage()
    await inviteePage.goto(acceptUrl)

    await inviteePage.getByLabel('New password').fill('invitee-password-123')
    await inviteePage.getByLabel('Confirm password').fill('invitee-password-123')
    await inviteePage.getByRole('button', { name: /set password/i }).click()
    await inviteePage.waitForURL('/dashboard')

    await invitee.close()
    assertClean(capture)
  })

  test('a staff member cannot reach the members page', async ({ page, capture }) => {
    await login(page, NURSE_EMAIL, SEED_PASSWORD)
    const res = await page.goto('/members')
    expect(res!.status()).toBe(404)
    // The navigation itself is the deliberately-provoked 404 (Next's
    // not-found response to `notFound()`), asserted on directly above —
    // whitelist it the same way import.spec.ts whitelists its own
    // deliberate 4xx rather than treating it as an unexpected failure.
    assertClean(capture, { allowRequests: [/\/members\b/] })
  })
})
