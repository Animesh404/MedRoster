import Credentials from 'next-auth/providers/credentials'
import type { NextAuthConfig } from 'next-auth'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { edgeAuthConfig } from '@/lib/auth/edge-config'

// Full config: Node runtime only (used by `auth.ts` and app/api/auth's route
// handler). Adds the Credentials provider and its Prisma/bcrypt lookup on top
// of the edge-safe base — see lib/auth/edge-config.ts for why middleware
// can't use this directly.
export const authConfig: NextAuthConfig = {
  ...edgeAuthConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = String(raw?.email ?? '').trim().toLowerCase()
        const password = String(raw?.password ?? '')
        if (!email || !password) return null

        const user = await prisma.user.findUnique({ where: { email } })
        if (!user) return null
        if (!(await bcrypt.compare(password, user.passwordHash))) return null

        return {
          id: String(user.id),
          email: user.email,
          name: user.name,
          role: user.role,
          profession: user.profession,
        }
      },
    }),
  ],
  // jwt/session callbacks (role/profession ride in the JWT, §6.3) are inherited
  // from edgeAuthConfig via the spread above — kept in one place so the shape
  // middleware verifies is exactly the shape sign-in produces.
}
