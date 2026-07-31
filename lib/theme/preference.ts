/**
 * The theme preference, and the one place that decides what a valid one is.
 *
 * Three states, not two. `system` is a real stored value rather than the
 * absence of one: without it, "follow my OS" and "never chose" are the same
 * state, and somebody who deliberately went back to following their OS gets
 * silently re-pinned by the next thing that writes a default.
 *
 * The cookie is the source of truth for rendering, because the server can read
 * it and put the right attribute on `<html>` before the page is sent — no
 * flash, no blocking script. The `User` row is the source of truth for
 * *carrying the choice to another device*: the cookie is per-browser, so
 * without it a member who set dark at work would face a white screen at home.
 * Login writes the cookie from the row, which is what reconciles the two.
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** What somebody who has never chosen gets — today's behaviour, unchanged. */
export const DEFAULT_THEME: ThemePreference = 'system'

/**
 * Cookie name. Not `__Host-` prefixed: that would require `Secure`, and the
 * app has to work over plain http on localhost.
 */
export const THEME_COOKIE = 'medroster.theme'

/**
 * A year. The preference is not a session thing — somebody who picked dark in
 * March should still have it in November without re-picking.
 */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Narrows an untrusted string to a preference, or null.
 *
 * Everything reaching this is untrusted: a cookie is client-editable, and the
 * API body is whatever was posted. Returning null rather than silently
 * defaulting lets each caller decide — the renderer falls back to the default,
 * the API rejects with a 400, and neither has to guess what the other did.
 */
export function parseThemePreference(value: unknown): ThemePreference | null {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
    ? (value as ThemePreference)
    : null
}

/**
 * The value for `<html data-theme>`.
 *
 * Always concrete, never empty: `globals.css` handles a missing attribute for
 * the case where this app did not render the markup at all, but anything this
 * app renders should say plainly which of the three states it is in.
 */
export function resolveThemeAttribute(value: unknown): ThemePreference {
  return parseThemePreference(value) ?? DEFAULT_THEME
}
