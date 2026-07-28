import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { createRng, seedClaims } from '@/lib/seed/claim-seeder'
import { runSeed } from '@/lib/seed/run-seed'
import { computeCoverage } from '@/lib/coverage'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const META = { source: 'SEED' as const, filename: 'x.csv', passwordHash: 'x' }
const NOW = new Date('2026-07-28T00:00:00Z')

async function importFixtures() {
  const db = await getTestDb()
  await db.$transaction((tx) =>
    applyStaffImport(tx, runStaffImport(readFileSync('staff.csv', 'utf8')), META), { timeout: 60_000 })
  await db.$transaction((tx) =>
    applyShiftImport(tx, runShiftImport(readFileSync('shifts.csv', 'utf8')),
      { ...META, filename: 'shifts.csv' }), { timeout: 60_000 })
  return db
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42), b = createRng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('produces a different sequence for a different seed', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  it('stays within [0, 1)', () => {
    const r = createRng(7)
    for (let i = 0; i < 200; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('seedClaims', () => {
  it('creates claims that all satisfy the business rules', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.2, now: NOW })

    // No user may hold two overlapping shifts.
    const claims = await db.claim.findMany({ include: { shift: true } })
    const byUser = new Map<number, { startsAt: Date; endsAt: Date }[]>()
    for (const c of claims) {
      const list = byUser.get(c.userId) ?? []
      list.push(c.shift)
      byUser.set(c.userId, list)
    }
    for (const [, shifts] of byUser) {
      shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      for (let i = 1; i < shifts.length; i++) {
        expect(shifts[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(shifts[i - 1]!.endsAt.getTime())
      }
    }
  })

  it('never exceeds a shift\'s requirement for any profession', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.2, now: NOW })

    const shifts = await db.shift.findMany({
      include: { requirements: true, claims: { include: { user: true } } },
    })
    for (const shift of shifts) {
      for (const req of shift.requirements) {
        const held = shift.claims.filter((c) => c.user.profession === req.profession).length
        expect(held, `shift ${shift.id} ${req.profession}`).toBeLessThanOrEqual(req.requiredCount)
      }
    }
  })

  it('is deterministic — the same seed yields the same claim set', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.2, now: NOW })
    const first = (await db.claim.findMany({ orderBy: [{ shiftId: 'asc' }, { userId: 'asc' }] }))
      .map((c) => `${c.shiftId}:${c.userId}`)

    await db.claim.deleteMany({})
    await seedClaims(db, { seed: 1337, fillRatio: 0.2, now: NOW })
    const second = (await db.claim.findMany({ orderBy: [{ shiftId: 'asc' }, { userId: 'asc' }] }))
      .map((c) => `${c.shiftId}:${c.userId}`)

    expect(second).toEqual(first)
  })

  it('produces all three coverage states so the dashboard demonstrates each, ' +
    'with EMPTY genuinely visible rather than a one-shift fluke', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.2, now: NOW })

    const shifts = await db.shift.findMany({
      include: { requirements: true, claims: { include: { user: true } } },
    })
    const allStatuses = shifts.map((shift) => {
      const req = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
      for (const r of shift.requirements) req[r.profession] = r.requiredCount
      const have = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
      for (const c of shift.claims) if (c.user.profession) have[c.user.profession] += 1
      return computeCoverage(req, have).status
    })
    const statuses = new Set(allStatuses)

    expect(statuses).toContain('FULL')
    expect(statuses).toContain('PARTIAL')
    expect(statuses).toContain('EMPTY')

    // A future tuning change to fillRatio must not quietly make the EMPTY
    // state near-invisible again (it was a single shift out of 109 at the
    // previous fillRatio of 0.55) — require a real, demoable count.
    const emptyCount = allStatuses.filter((s) => s === 'EMPTY').length
    expect(emptyCount).toBeGreaterThanOrEqual(5)
  })
})

describe('runSeed', () => {
  it('running the seed twice adds no duplicate ImportRun rows or claims', async () => {
    const db = await getTestDb()

    const first = await runSeed(db, { passwordHash: 'x', now: NOW })
    const firstRunCount = await db.importRun.count()
    // One SEED ImportRun for staff.csv, one for shifts.csv.
    expect(firstRunCount).toBe(2)
    const firstClaimCount = await db.claim.count()
    expect(firstClaimCount).toBe(first.claimsCreated)
    expect(firstClaimCount).toBeGreaterThan(0)

    const second = await runSeed(db, { passwordHash: 'x', now: NOW })
    const secondRunCount = await db.importRun.count()
    expect(secondRunCount).toBe(firstRunCount)
    const secondClaimCount = await db.claim.count()
    expect(secondClaimCount).toBe(firstClaimCount)
    // The second pass recognizes prior work and skips both the imports and
    // the claim seeding rather than re-attempting either.
    expect(second.existingClaims).toBe(firstClaimCount)
    expect(second.claimsAttempted).toBe(0)
  })
})
