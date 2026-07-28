import type { NextAuthConfig, Session } from 'next-auth'
import type { JWT } from 'next-auth/jwt'

/**
 * Edge-safe subset of the full Auth.js config (see `lib/auth/config.ts`).
 *
 * `middleware.ts` runs in the Edge Runtime by default, which lacks the
 * Node-only APIs (`node:util/types`, etc.) that `pg` — and therefore
 * `@prisma/adapter-pg` and `lib/db/client.ts` — depend on. This config must
 * never import the Credentials provider or anything that transitively pulls
 * in Prisma: no `bcryptjs`, no `@/lib/db/client`.
 *
 * Middleware only needs to *verify* the JWT session cookie (signed with
 * `AUTH_SECRET`), not query the database, so `providers: []` is sufficient —
 * Auth.js's `auth()` wrapper decodes and verifies the existing token without
 * ever calling `authorize()`. The jwt/session callbacks below are pure
 * token-shaping (no I/O), so `role`/`profession` set at sign-in time are
 * still readable from `req.auth.user` in middleware.
 */
export const edgeAuthConfig: NextAuthConfig = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = Number(user.id)
        token.role = user.role
        token.profession = user.profession
      }
      return token
    },
    session({ session, token }: { session: Session; token: JWT }) {
      session.user.id = token.uid as number
      session.user.role = token.role as never
      session.user.profession = token.profession as never
      return session
    },
  },
}
