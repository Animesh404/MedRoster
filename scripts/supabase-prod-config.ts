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
const GATING: Record<string, string | boolean> = {
  // Invite-only. Layer 1 of three: the other two (`shouldCreateUser: false` on
  // magic link, and the roster check in /auth/callback) keep a stranger out of
  // roster data, but without this anyone can create an auth account at all.
  disable_signup: true,

  // Every emailed link is built from SiteURL. Left at localhost, an invite
  // sends the recipient to a machine they do not have.
  site_url: APP_URL,
  uri_allow_list: `${APP_URL}/**`,
}

/**
 * Applied SEPARATELY, because Supabase refuses them on a free-tier project
 * still using the built-in mailer:
 *
 *   "Email template modification is not available for free tier projects using
 *    the default email provider."
 *
 * Sent together with the settings above, that 400 took all of them down with
 * it — one blocked setting stopped three applicable ones. Two requests means a
 * project that cannot have custom templates still gets its signup gate closed
 * and its URLs corrected.
 */
const TEMPLATES: Record<string, string> = {
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

const REQUIRED: Record<string, string | boolean> = { ...GATING, ...TEMPLATES }

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

  // Two requests, not one. See the note on TEMPLATES.
  const groups: [string, Record<string, string | boolean>][] = [
    ['settings', GATING],
    ['email templates', TEMPLATES],
  ]

  let blocked: string | null = null
  for (const [label, payload] of groups) {
    const pending = Object.keys(payload).filter((k) => stale.includes(k))
    if (pending.length === 0) continue

    const res = await fetch(API, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      console.log(`\nApplied ${pending.length} ${label}.`)
      continue
    }

    const detail = await res.text().catch(() => '')
    if (label === 'email templates' && /free tier|custom SMTP/i.test(detail)) {
      // Not a script failure. The project cannot accept templates at all until
      // SMTP is configured, and saying so is more use than a stack trace.
      blocked = detail
      continue
    }
    throw new Error(`PATCH ${label} failed: ${res.status} ${detail}`)
  }

  // Read back rather than trusting the 200s. The API accepts unknown keys
  // silently, so a typo'd setting name would otherwise report success while
  // changing nothing.
  const after = drifted(await readConfig())
  const templateKeys = new Set(Object.keys(TEMPLATES))
  const stillWrong = after.filter((k) => !templateKeys.has(k))

  if (stillWrong.length > 0) {
    console.error(`\nApplied, but these did not take effect: ${stillWrong.join(', ')}`)
    console.error('Check the key names against the Management API schema.')
    process.exit(1)
  }

  if (blocked !== null) {
    console.error('\nEMAIL TEMPLATES NOT APPLIED — Supabase refused them:')
    console.error(`  ${blocked}`)
    console.error(
      '\nUntil custom SMTP is configured, this project sends Supabase\'s DEFAULT\n' +
      'templates, which put the token in the URL fragment. A fragment is never\n' +
      'sent to the server, so /auth/confirm receives nothing: invites and password\n' +
      'resets will send a real email whose link cannot work.\n\n' +
      'Configure SMTP (Authentication -> Emails -> SMTP Settings), then re-run this.',
    )
    process.exit(1)
  }

  console.log(`\nApplied ${stale.length} setting(s). Verified by reading them back.`)
}

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
