import { readFileSync } from 'node:fs'
import type { PrismaClient } from '@prisma/client'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { TX_OPTIONS } from '@/lib/rules/assign'
import { seedClaims } from '@/lib/seed/claim-seeder'

/**
 * Fraction of open slots the deterministic claim pass tries to fill. Measured
 * against the real dataset: 0.20 yields FULL/PARTIAL/EMPTY ≈ 7/92/10 (~47%
 * filled), keeping the roster visibly under-staffed (the project's premise)
 * while still surfacing all three coverage states robustly. No value
 * produces a balanced three-way split — most shifts need 2-3 professions
 * whose fill targets are drawn independently, so PARTIAL is a structural
 * attractor and simultaneous saturation (FULL) or simultaneous zero (EMPTY)
 * are inherently rarer.
 */
export const FILL_RATIO = 0.2

export interface RunSeedOptions {
  /** Pinned "now" for claim seeding, mainly for deterministic tests. */
  now?: Date
}

export interface RunSeedResult {
  staffStats: unknown
  shiftStats: unknown
  existingClaims: number
  claimsAttempted: number
  claimsCreated: number
}

/**
 * The full seed workflow: manager account, staff/shift import, and the
 * deterministic claim pass. Factored out of prisma/seed.ts (which just wires
 * up the real `prisma` client) so tests can run it directly against a
 * Testcontainers database.
 */
export async function runSeed(db: PrismaClient, opts: RunSeedOptions = {}): Promise<RunSeedResult> {
  // Idempotent: upserts keyed on the CSV ids mean re-running never duplicates.
  await db.user.upsert({
    where: { email: 'manager@clinicmail.test' },
    create: {
      email: 'manager@clinicmail.test', name: 'Dana Okonkwo',
      role: 'MANAGER',
    },
    update: {},
  })

  // `docker compose up` runs migrate + seed on every container start, so an
  // unguarded import would add a fresh ImportRun (and its ImportRowResult
  // rows) on every boot even though the CSVs never change. Guard on a prior
  // SEED-sourced run for the same filename — mirrors the claim guard below —
  // while leaving `POST /api/imports` (source: 'UPLOAD') untouched: a
  // manager's upload should always create its own audit row.
  const existingStaffRun = await db.importRun.findFirst({
    where: { source: 'SEED', filename: 'staff.csv' },
  })
  let staffStats: unknown
  if (!existingStaffRun) {
    const staffResult = runStaffImport(readFileSync('staff.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyStaffImport(tx, staffResult, {
        source: 'SEED', filename: 'staff.csv',
      }), { ...TX_OPTIONS, timeout: 60_000 })
    staffStats = staffResult.stats
  } else {
    staffStats = existingStaffRun.stats
  }

  const existingShiftRun = await db.importRun.findFirst({
    where: { source: 'SEED', filename: 'shifts.csv' },
  })
  let shiftStats: unknown
  if (!existingShiftRun) {
    const shiftResult = runShiftImport(readFileSync('shifts.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyShiftImport(tx, shiftResult, {
        source: 'SEED', filename: 'shifts.csv',
      }), { ...TX_OPTIONS, timeout: 120_000 })
    shiftStats = shiftResult.stats
  } else {
    shiftStats = existingShiftRun.stats
  }

  const existingClaims = await db.claim.count()
  if (existingClaims > 0) {
    return { staffStats, shiftStats, existingClaims, claimsAttempted: 0, claimsCreated: 0 }
  }

  // seedClaims only considers shifts strictly after `now`, so the exact
  // claim count is date-dependent (a shift crossing from future to past
  // between runs changes the pool) — that variance is expected and is not
  // a sign of RNG nondeterminism, which remains byte-identical same-day.
  const { attempted, created } = await seedClaims(db, {
    seed: 1337, fillRatio: FILL_RATIO, ...(opts.now ? { now: opts.now } : {}),
  })
  return { staffStats, shiftStats, existingClaims, claimsAttempted: attempted, claimsCreated: created }
}
