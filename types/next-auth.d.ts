import type { Profession, Role } from '@prisma/client'
import 'next-auth'

declare module 'next-auth' {
  interface User { role: Role; profession: Profession | null }
  interface Session {
    user: { id: number; email: string; name: string; role: Role; profession: Profession | null }
  }
}
