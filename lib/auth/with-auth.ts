import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { statusFor, type AppError } from '@/lib/domain/errors'
import { can, type Permission, type Principal } from './permissions'

export interface AuthedContext<P = Record<string, string>> {
  params: Promise<P>
  principal: Principal
}

export type AuthedHandler<P> = (
  req: Request,
  ctx: AuthedContext<P>,
) => Promise<Response>

/**
 * Non-enumerable brand stamped onto every function `withAuth` returns.
 *
 * `tests/rbac/routes.test.ts`'s regex check (does the right-hand side of
 * `export const VERB = ...` literally contain the text `withAuth(`) is
 * evadable by construction — `export { GET }` re-exporting a handler built
 * elsewhere, or the call simply reformatted onto another line, both slip
 * past a text match while still being unguarded (or guarded) in reality. The
 * brand lets the test assert something it can't be fooled about: the actual
 * function object a route exports was genuinely produced by this factory.
 */
export const WITH_AUTH_BRAND = Symbol('withAuth.brand')

/**
 * Wraps a route handler with authentication and a declared permission.
 * Every handler in app/api must be produced by this function — a route that
 * forgets is caught by tests/rbac/routes.test.ts. §6.3
 */
export function withAuth<P = Record<string, string>>(
  permission: Permission,
  handler: AuthedHandler<P>,
) {
  const wrapped = async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Sign in required.' } }, { status: 401 })
    }

    const principal: Principal = {
      id: session.user.id,
      role: session.user.role,
      profession: session.user.profession,
    }

    if (!can(principal, permission)) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' } },
        { status: 403 },
      )
    }

    // Everything past this point is route-handler-authored: a Zod refine
    // throwing, an un-caught Prisma error, a programming mistake — none of
    // it should ever reach the client as a raw stack trace. This boundary
    // does not touch the 401/403 decisions above; it only catches what the
    // handler itself throws.
    try {
      return await handler(req, { params: ctx.params, principal })
    } catch (err) {
      console.error('Unhandled error in route handler', err)
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } },
        { status: 500 },
      )
    }
  }

  Object.defineProperty(wrapped, WITH_AUTH_BRAND, { value: true, enumerable: false })
  return wrapped
}

/** Uniform error body for domain failures. */
export function errorResponse(err: AppError): Response {
  return NextResponse.json({ error: err }, { status: statusFor(err.code) })
}
