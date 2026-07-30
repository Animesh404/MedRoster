const FALLBACK = '/dashboard'

/**
 * Confines a post-login redirect target to a same-origin relative path.
 *
 * `next` arrives from an untrusted source — a query parameter a link author
 * fully controls (see app/login/page.tsx, which reads it from searchParams
 * and threads it through a hidden form field) — and used to be handed
 * straight to `redirect()` in app/login/actions.ts. `next/navigation`'s
 * `redirect()` places no restriction on its target, so a link like
 * `/login?next=https://medroster-login.evil/` shows a genuine MedRoster URL
 * and a genuine login form; the victim authenticates for real and is then
 * bounced to an attacker page asking them to "sign in again" (an open
 * redirect). The old Auth.js code passed `next` as `redirectTo`, which
 * Auth.js's default redirect callback confined to the app origin — that
 * confinement was lost when Auth.js was removed. This restores it.
 *
 * Only a value that starts with exactly one `/` — and is not itself
 * protocol-relative — is accepted; everything else falls back to
 * `/dashboard`. The `new URL` resolution below is the authoritative check:
 * browsers (and Node/WHATWG's URL parser) normalise a leading backslash to a
 * slash for special schemes, so `/\evil.example` and `/\/evil.example`
 * resolve exactly like `//evil.example` — protocol-relative, off-origin —
 * and are caught the same way an absolute `https://evil.example` is.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return FALLBACK

  const trimmed = next.trim()
  if (!trimmed) return FALLBACK
  if (!trimmed.startsWith('/')) return FALLBACK
  // Fast-path reject before even asking URL to resolve it: a second leading
  // `/` or `\` is protocol-relative, which `new URL` below would also catch,
  // but rejecting it here keeps the intent readable without relying on a
  // reader knowing WHATWG's backslash-normalisation rule.
  if (trimmed.length > 1 && (trimmed[1] === '/' || trimmed[1] === '\\')) return FALLBACK

  const SENTINEL_ORIGIN = 'http://safe-redirect.invalid'
  let resolved: URL
  try {
    resolved = new URL(trimmed, SENTINEL_ORIGIN)
  } catch {
    return FALLBACK
  }
  if (resolved.origin !== SENTINEL_ORIGIN) return FALLBACK

  return trimmed
}
