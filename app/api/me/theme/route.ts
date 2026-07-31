import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse, type AuthedContext } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  parseThemePreference,
} from '@/lib/theme/preference'

/**
 * Saves the caller's own theme preference.
 *
 * Guarded by `shift:read` — the permission every role holds — for the same
 * reason `/api/notices/[id]` is: there is no authorization question here beyond
 * *whose* preference, and that is answered by writing to `ctx.principal.id`
 * rather than to any id from the request. A member changing their own colour
 * scheme is not an elevated act.
 *
 * The cookie is already set by the client before this is called, so the write
 * below is about the choice following somebody to another browser, not about
 * this one. The response re-sets it anyway: if a client ever calls this without
 * having set the cookie, the two would otherwise disagree until the next
 * navigation, and the DOM would show a theme the server does not know about.
 */
export const PATCH = withAuth('shift:read', async (req: Request, ctx: AuthedContext) => {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return errorResponse(createAppError('INVALID_INPUT', 'Expected a JSON body.'))
  }

  const theme = parseThemePreference((body as { theme?: unknown } | null)?.theme)
  if (theme === null) {
    return errorResponse(
      createAppError('INVALID_INPUT', 'Theme must be one of: light, dark, system.'),
    )
  }

  await prisma.user.update({
    // `ctx.principal.id`, never an id from the request — the alternative is an
    // endpoint that lets anyone restyle anyone.
    where: { id: ctx.principal.id },
    data: { themePreference: theme },
  })

  const res = NextResponse.json({ theme })
  res.cookies.set(THEME_COOKIE, theme, {
    path: '/',
    maxAge: THEME_COOKIE_MAX_AGE,
    // Lax, not Strict: somebody arriving from an emailed invite link is a
    // cross-site navigation, and Strict withholds the cookie on exactly that
    // first render.
    sameSite: 'lax',
    // Readable by the toggle, which sets it directly for the instant flip.
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
  })
  return res
})
