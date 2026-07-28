import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { AppShell } from '@/components/app-shell'
import type { Principal } from '@/lib/auth/permissions'

/**
 * Wraps every guarded route (`/dashboard`, `/my-shifts`, `/shifts/*`,
 * `/import`) in the shell. `middleware.ts` already redirects an unauthenticated
 * request before it gets here (§middleware.ts); this check is defense in
 * depth, not the primary guard.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth()
  if (!session?.user) {
    redirect('/login')
  }

  const principal: Principal = {
    id: session.user.id,
    role: session.user.role,
    profession: session.user.profession,
  }

  return (
    <AppShell principal={principal} name={session.user.name} email={session.user.email}>
      {children}
    </AppShell>
  )
}
