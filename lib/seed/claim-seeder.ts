import type { PrismaClient } from '@prisma/client'
import { assignClaim } from '@/lib/rules/assign'

/** Mulberry32 — small, fast, fully deterministic. No Math.random anywhere in the seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export interface SeedClaimsOptions {
  seed: number
  /** Roughly what fraction of open slots to attempt to fill. */
  fillRatio: number
  now?: Date
}

/**
 * Populates the roster with claims so the coverage dashboard shows all three
 * states rather than a wall of empty shifts (§7.2).
 *
 * Every claim goes through assignClaim — the same validator and the same locks
 * a real staff member hits. Nothing is written directly, so this doubles as an
 * end-to-end exercise of the rules engine and cannot produce a roster the
 * application itself would consider invalid.
 */
export async function seedClaims(
  db: PrismaClient,
  opts: SeedClaimsOptions,
): Promise<{ attempted: number; created: number }> {
  const rng = createRng(opts.seed)
  const now = opts.now ?? new Date()

  const shifts = await db.shift.findMany({
    where: { startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    include: { requirements: true },
  })

  const staff = await db.user.findMany({
    where: { role: 'STAFF' },
    orderBy: { id: 'asc' },
    select: { id: true, profession: true },
  })

  const byProfession = new Map<string, number[]>()
  for (const person of staff) {
    if (!person.profession) continue
    const list = byProfession.get(person.profession) ?? []
    list.push(person.id)
    byProfession.set(person.profession, list)
  }

  let attempted = 0
  let created = 0

  // Shuffled shift order means the filled shifts are scattered across the month
  // rather than front-loaded, so any week the reviewer lands on shows a mix.
  for (const shift of shuffle(shifts, rng)) {
    for (const requirement of shift.requirements) {
      if (requirement.requiredCount === 0) continue

      const pool = byProfession.get(requirement.profession) ?? []
      if (pool.length === 0) continue

      // Vary how full each shift gets: some reach FULL, most land PARTIAL,
      // and the shifts skipped entirely stay EMPTY.
      const target = Math.round(requirement.requiredCount * (opts.fillRatio + rng() * 0.6))
      const wanted = Math.min(requirement.requiredCount, Math.max(0, target))

      for (const userId of shuffle(pool, rng).slice(0, wanted)) {
        attempted += 1
        // Rejections are expected and fine — the roster is deliberately
        // over-subscribed, so many candidates already hold an overlapping shift.
        const result = await assignClaim({ db, shiftId: shift.id, userId, actorId: userId, now })
        if ('claimId' in result) created += 1
      }
    }
  }

  return { attempted, created }
}
