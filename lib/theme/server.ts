import 'server-only'
import { cookies } from 'next/headers'
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  parseThemePreference,
  resolveThemeAttribute,
  type ThemePreference,
} from './preference'

/**
 * The theme this request should render in.
 *
 * Cookie only — deliberately no database read. This runs in the root layout on
 * every page including the public ones, and reaching for the session or the
 * `User` row here would put an auth round trip in front of the marketing page
 * for a colour scheme.
 *
 * The stored preference reaches a new browser a different way: sign-in writes
 * the cookie from the member's row (see `adoptStoredTheme`). By the time any
 * page renders for them, the cookie already says what their account says.
 */
export async function currentTheme(): Promise<ThemePreference> {
  return resolveThemeAttribute((await cookies()).get(THEME_COOKIE)?.value)
}

/**
 * Seeds the theme cookie from a member's saved preference at sign-in.
 *
 * This is what makes "the choice follows you to another device" true. Without
 * it the account column would be written and never read, and a member who set
 * dark at work would still get a white screen at home — the cookie being
 * per-browser is the entire problem it solves.
 *
 * Does NOT overwrite a cookie that already exists. Somebody who picked a theme
 * on the login page itself chose it seconds ago; replacing that with a value
 * saved months earlier would undo a choice they just watched take effect.
 */
export async function adoptStoredTheme(stored: string | null): Promise<void> {
  const preference = parseThemePreference(stored)
  if (preference === null) return

  const jar = await cookies()
  if (parseThemePreference(jar.get(THEME_COOKIE)?.value) !== null) return

  jar.set(THEME_COOKIE, preference, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    sameSite: 'lax',
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
  })
}
