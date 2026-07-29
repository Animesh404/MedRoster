import { headers } from 'next/headers'

/**
 * Calls this app's own API routes from a Server Component, forwarding the
 * incoming request's cookie so the route's `withAuth` sees the same
 * session — the same pattern `app/(app)/dashboard/page.tsx` established.
 * Centralised here because Task 19 adds three more server pages
 * (`/shifts/[id]`, `/my-shifts`, `/import*`) that all need it.
 */
export async function internalFetch(path: string, init?: RequestInit): Promise<Response> {
  const requestHeaders = await headers()
  const host = requestHeaders.get('host')
  const proto = requestHeaders.get('x-forwarded-proto') ?? 'http'
  const cookie = requestHeaders.get('cookie') ?? ''
  return fetch(`${proto}://${host}${path}`, {
    ...init,
    headers: { ...init?.headers, cookie },
    cache: 'no-store',
  })
}
