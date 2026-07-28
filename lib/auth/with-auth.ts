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
 * Wraps a route handler with authentication and a declared permission.
 * Every handler in app/api must be produced by this function — a route that
 * forgets is caught by tests/rbac/routes.test.ts. §6.3
 */
export function withAuth<P = Record<string, string>>(
  permission: Permission,
  handler: AuthedHandler<P>,
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
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

    return handler(req, { params: ctx.params, principal })
  }
}

/** Uniform error body for domain failures. */
export function errorResponse(err: AppError): Response {
  return NextResponse.json({ error: err }, { status: statusFor(err.code) })
}
