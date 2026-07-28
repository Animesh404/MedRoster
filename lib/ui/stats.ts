import { prisma } from '@/lib/db/client'

export interface RosterStats {
  staffCount: number
  shiftCount: number
  claimCount: number
}

/**
 * The three live numbers shown on the landing page's stats band and the
 * login screen's left pane. Real counts from the seeded database rather than
 * fabricated marketing figures — reused by both server components so they
 * can never drift apart.
 *
 * Callers should mark their route `force-dynamic` (or otherwise avoid static
 * prerendering) so these stay live rather than frozen at build time.
 */
export async function getRosterStats(): Promise<RosterStats> {
  const [staffCount, shiftCount, claimCount] = await Promise.all([
    prisma.user.count({ where: { role: 'STAFF' } }),
    prisma.shift.count(),
    prisma.claim.count(),
  ])
  return { staffCount, shiftCount, claimCount }
}
