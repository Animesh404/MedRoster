import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db/client'
import { isoWeekOf, weekBounds } from '@/lib/domain/time'

/**
 * The ISO week a visitor should land on when they haven't asked for one.
 *
 * Normally that is simply the current week. But the seeded roster covers a fixed
 * range in the source spreadsheet (2026-08-03 to 2026-08-30), so anyone opening
 * the dashboard outside that range landed on a week with nothing in it: every
 * count zero, every day reading "No shifts scheduled", and — worst of all — a
 * coverage gauge reading 100%, which is 100% of nothing. The app looked broken
 * on the single most important screen.
 *
 * So: if the current week holds no shifts, fall back to the nearest week that
 * does, preferring the next upcoming one and otherwise the most recent past one.
 *
 * This applies ONLY when no week was requested. Explicitly navigating to an empty
 * week must still show that week honestly — "there is nothing scheduled here" is
 * a real answer, and silently redirecting away from it would be worse than the
 * problem being fixed.
 */
export async function resolveDefaultWeek(
  now: Date = new Date(),
  // Injected so tests can point this at their Testcontainers database, matching
  // how `assignClaim` and the other DB-touching helpers are written.
  db: Pick<PrismaClient, 'shift'> = prisma,
): Promise<string> {
  const currentWeek = isoWeekOf(now)

  const { start, end } = weekBounds(currentWeek)
  const inCurrentWeek = await db.shift.count({
    where: { startsAt: { gte: start, lt: end } },
  })
  if (inCurrentWeek > 0) return currentWeek

  // Nearest upcoming shift first — a rota is forward-looking, and a manager
  // opening it wants what is coming, not what already happened.
  const upcoming = await db.shift.findFirst({
    where: { startsAt: { gte: end } },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true },
  })
  if (upcoming) return isoWeekOf(upcoming.startsAt)

  const past = await db.shift.findFirst({
    where: { startsAt: { lt: start } },
    orderBy: { startsAt: 'desc' },
    select: { startsAt: true },
  })
  if (past) return isoWeekOf(past.startsAt)

  // Genuinely no shifts anywhere: the current week is the honest answer, and the
  // empty state invites creating one.
  return currentWeek
}
