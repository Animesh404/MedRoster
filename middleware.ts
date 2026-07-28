import { auth } from '@/auth'

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
