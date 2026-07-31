/**
 * Applies MedRoster's required auth settings to the HOSTED Supabase project.
 *
 * `supabase/config.toml` configures the LOCAL stack only. Nothing carries it to
 * a hosted project, so the settings the app depends on — invite-only signup and
 * the `{{ .TokenHash }}` email templates — existed on developer machines and
 * simply were not present in production. Both failures are quiet: signup being
 * open looks like nothing, and a wrong email template sends a real email whose
 * link cannot work.
 *
 * This makes the hosted config reproducible and reviewable, so it can drift
 * back only by someone changing it in the dashboard on purpose.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=... APP_URL=https://... \
 *     npx tsx scripts/supabase-prod-config.ts [--check]
 *
 * `--check` reports drift and exits non-zero without changing anything, which
 * is what you want from a pipeline.
 *
 * The access token is a Supabase PERSONAL ACCESS TOKEN (`sbp_...`) from
 * Account → Access Tokens. The `service_role` key cannot change project
 * settings — different credential, different API.
 */

import { readFileSync } from 'node:fs'

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const REF = process.env.SUPABASE_PROJECT_REF
const APP_URL = process.env.APP_URL?.replace(/\/$/, '')
const CHECK_ONLY = process.argv.includes('--check')

if (!TOKEN || !REF || !APP_URL) {
  console.error('Missing required environment:')
  if (!TOKEN) console.error('  SUPABASE_ACCESS_TOKEN — a personal access token (sbp_...), NOT the service_role key')
  if (!REF) console.error('  SUPABASE_PROJECT_REF   — e.g. the ref in your project URL')
  if (!APP_URL) console.error('  APP_URL                — e.g. https://medroster.example.com')
  process.exit(1)
}

const API = `https://api.supabase.com/v1/projects/${REF}/config/auth`

function template(name: string): string {
  return readFileSync(`supabase/templates/${name}.html`, 'utf8').trim()
}

/**
 * The settings the app actually depends on, each with the failure it prevents.
 *
 * Only these. This script deliberately does NOT mirror all of config.toml —
 * a tool that overwrites every setting makes any dashboard change look like
 * drift, and people stop running it.
 */
const REQUIRED: Record<string, string | boolean> = {
  // Invite-only. Layer 1 of three: the other two (`shouldCreateUser: false` on
  // magic link, and the roster check in /auth/callback) keep a stranger out of
  // roster data, but without this anyone can create an auth account at all.
  disable_signup: true,

  // Every emailed link is built from SiteURL. Left at localhost, an invite
  // sends the recipient to a machine they do not have.
  site_url: APP_URL,
  uri_allow_list: `${APP_URL}/**`,

  // The templates are the load-bearing part. Supabase's defaults use
  // `{{ .ConfirmationURL }}`, which returns the token in the URL FRAGMENT —
  // never sent to the server, so /auth/confirm receives nothing and the flow
  // dies silently. Ours pass `{{ .TokenHash }}` as a query parameter, which
  // the route exchanges via verifyOtp.
  mailer_templates_invite_content: template('invite'),
  mailer_subjects_invite: 'You have been invited to MedRoster',
  mailer_templates_recovery_content: template('recovery'),
  mailer_subjects_recovery: 'Reset your MedRoster password',
  mailer_templates_magic_link_content: template('magic-link'),
  mailer_subjects_magic_link: 'Sign in to MedRoster',
}

async function readConfig(): Promise<Record<string, unknown>> {
  const res = await fetch(API, { headers: { Authorization: `Bearer ${TOKEN}` } })
  if (!res.ok) {
    throw new Error(`GET config failed: ${res.status} ${await res.text().catch(() => '')}`)
  }
  return await res.json() as Record<string, unknown>
}

function drifted(current: Record<string, unknown>): string[] {
  return Object.entries(REQUIRED)
    .filter(([key, want]) => {
      const have = current[key]
      // Templates are compared trimmed: the API round-trips whitespace.
      if (typeof want === 'string' && typeof have === 'string') return have.trim() !== want.trim()
      return have !== want
    })
    .map(([key]) => key)
}

async function main(): Promise<void> {
  console.log(`Supabase auth config for project ${REF}`)
  console.log(`${CHECK_ONLY ? 'Checking' : 'Applying'} ${Object.keys(REQUIRED).length} settings\n`)

  const before = await readConfig()
  const stale = drifted(before)

  for (const key of Object.keys(REQUIRED)) {
    const status = stale.includes(key) ? 'DRIFT' : 'ok   '
    console.log(`  ${status}  ${key}`)
  }

  if (stale.length === 0) {
    console.log('\nAll required settings already match.')
    return
  }

  if (CHECK_ONLY) {
    console.error(`\n${stale.length} setting(s) differ from what the app requires:`)
    for (const key of stale) console.error(`  - ${key}`)
    console.error('\nRun without --check to apply.')
    process.exit(1)
  }

  const res = await fetch(API, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(REQUIRED),
  })
  if (!res.ok) {
    throw new Error(`PATCH config failed: ${res.status} ${await res.text().catch(() => '')}`)
  }

  // Read back rather than trusting the 200. The API accepts unknown keys
  // silently, so a typo'd setting name would otherwise report success while
  // changing nothing.
  const after = drifted(await readConfig())
  if (after.length > 0) {
    console.error(`\nApplied, but these did not take effect: ${after.join(', ')}`)
    console.error('Check the key names against the Management API schema.')
    process.exit(1)
  }

  console.log(`\nApplied ${stale.length} setting(s). Verified by reading them back.`)
}

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
