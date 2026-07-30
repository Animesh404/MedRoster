import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHero } from '@/components/page-hero'
import { currentSessionUser } from '@/lib/auth/session'
import { can } from '@/lib/auth/permissions'
import { prisma } from '@/lib/db/client'
import { MembersTable } from './members-table'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Members — MedRoster' }

/**
 * Manager-only. Renders the roster; every mutation goes through
 * `app/api/members/*`, which is what keeps `lib/supabase/admin.ts` (and the
 * service-role key) out of this file's import graph — a `.tsx` is treated as
 * client-reachable by tests/auth/admin-containment.test.ts, transitively.
 *
 * The status column is deliberately NOT derived here: it needs the Supabase
 * admin API, so the client fetches it from GET /api/members on mount.
 */
export default async function MembersPage() {
  const session = await currentSessionUser()
  if (!session) notFound()
  if (!can(session.principal, 'member:read')) notFound()

  const profiles = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, email: true, role: true, profession: true },
  })

  // Rendered immediately with an optimistic 'active'; MembersTable replaces
  // these with real statuses from GET /api/members on mount, so the page is
  // useful before the admin round-trip completes.
  const initialMembers = profiles.map((p) => ({ ...p, status: 'active' as const }))

  return (
    <div className="space-y-6">
      <PageHero eyebrow="Team" title="Members">
        Invite colleagues, chase pending invites, and offboard people who have left.
      </PageHero>
      <MembersTable initialMembers={initialMembers} currentUserId={session.principal.id} />
    </div>
  )
}
