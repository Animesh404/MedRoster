import Credentials from 'next-auth/providers/credentials'
import type { NextAuthConfig, Session } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
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
  callbacks: {
    // role and profession ride in the JWT so permission checks need no DB hit (§6.3)
    jwt({ token, user }) {
      if (user) {
        token.uid = Number(user.id)
        token.role = user.role
        token.profession = user.profession
      }
      return token
    },
    // Auth.js's inferred callback params intersect the jwt- and database-strategy
    // session shapes (the latter carries AdapterUser, whose `id` is a string),
    // which collapses `session.user.id` to `never`. Annotating the params
    // explicitly with the jwt-strategy types we actually configured avoids that.
    session({ session, token }: { session: Session; token: JWT }) {
      session.user.id = token.uid as number
      session.user.role = token.role as never
      session.user.profession = token.profession as never
      return session
    },
  },
}
