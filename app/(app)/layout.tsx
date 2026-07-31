import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/app-shell'
import { currentSessionUser } from '@/lib/auth/session'
import { currentTheme } from '@/lib/theme/server'

/**
 * Wraps every guarded route (`/dashboard`, `/my-shifts`, `/shifts/*`,
 * `/import`) in the shell. `middleware.ts` already redirects a request with no
 * Supabase session before it gets here; this check is defense in depth AND the
 * only place a *deactivated* member is caught, since middleware cannot reach
 * the database to know that.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await currentSessionUser()
  if (!session) {
    redirect('/login')
  }

  return (
    <AppShell
      principal={session.principal}
      name={session.name}
      email={session.email}
      theme={await currentTheme()}
    >
      {children}
    </AppShell>
  )
}
