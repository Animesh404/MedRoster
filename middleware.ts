import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Two jobs, and the order matters.
 *
 *  1. Refresh the Supabase session cookie. Access tokens are short-lived; if
 *     nothing refreshes them a signed-in user is silently logged out mid-visit.
 *     The refreshed cookies are written onto `res`, which is why every path
 *     below must return THAT response object — returning a fresh
 *     `NextResponse.next()` would drop the refresh on the floor.
 *  2. Redirect unauthenticated requests to /login.
 *
 * This file must not import Prisma or `@/lib/db/client`: it runs in the Edge
 * Runtime, which lacks the Node internals `pg` needs. That is also why it can
 * only ask "is there a session?" and not "is this member still active?" —
 * deactivation is caught in app/(app)/layout.tsx, which can reach the database.
 */
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) req.cookies.set(name, value)
          res = NextResponse.next({ request: req })
          for (const { name, value, options } of cookiesToSet) res.cookies.set(name, value, options)
        },
      },
    },
  )

  const { data } = await supabase.auth.getUser()

  if (!data.user) {
    const url = new URL('/login', req.nextUrl.origin)
    url.searchParams.set('next', req.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  return res
}

export const config = {
  matcher: ['/dashboard/:path*', '/shifts/:path*', '/my-shifts/:path*', '/import/:path*'],
}
