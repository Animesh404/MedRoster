import NextAuth from 'next-auth'
import { edgeAuthConfig } from '@/lib/auth/edge-config'

// Uses the edge-safe config (no Prisma/pg) so this module stays loadable in
// the Edge Runtime — see lib/auth/edge-config.ts. Do NOT import `@/auth` or
// `@/lib/auth/config` here; both pull in the Credentials provider, which
// transitively imports `lib/db/client.ts` (Prisma via `@prisma/adapter-pg`,
// which uses Node-only `pg` internals unavailable at the edge).
const { auth } = NextAuth(edgeAuthConfig)

export default auth((req) => {
  const isApp = req.nextUrl.pathname.startsWith('/dashboard')
    || req.nextUrl.pathname.startsWith('/shifts')
    || req.nextUrl.pathname.startsWith('/my-shifts')
    || req.nextUrl.pathname.startsWith('/import')

  if (isApp && !req.auth) {
    const url = new URL('/login', req.nextUrl.origin)
    url.searchParams.set('next', req.nextUrl.pathname)
    return Response.redirect(url)
  }
})

export const config = {
  matcher: ['/dashboard/:path*', '/shifts/:path*', '/my-shifts/:path*', '/import/:path*'],
}
