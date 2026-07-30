import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const META = { source: 'SEED' as const, filename: 'staff.csv' }

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('applyStaffImport', () => {
  it('persists one user per accepted record and one report row per source line', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) => applyStaffImport(tx, result, META))

    expect(await db.user.count({ where: { role: 'STAFF' } })).toBe(34)
    expect(await db.importRowResult.count({ where: { importRunId: runId } })).toBe(41)
  })

  it('records the raw line and the issues on every report row', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) => applyStaffImport(tx, result, META))

    const janitor = await db.importRowResult.findFirst({
      where: { importRunId: runId, rawRow: { contains: 'Janitor' } },
    })
    expect(janitor!.outcome).toBe('REJECTED')
    expect(JSON.stringify(janitor!.issues)).toContain('UNKNOWN_PROFESSION')
  })

  it('is idempotent — re-running the import does not duplicate users', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    await db.$transaction((tx) => applyStaffImport(tx, result, META))
    await db.$transaction((tx) => applyStaffImport(tx, result, META))
    expect(await db.user.count({ where: { role: 'STAFF' } })).toBe(34)
  })
})

describe('applyShiftImport', () => {
  it('persists 109 shifts with their requirement rows', async () => {
    const db = await getTestDb()
    const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyShiftImport(tx, result, { ...META, filename: 'shifts.csv' }), { timeout: 30_000 })

    expect(await db.shift.count()).toBe(109)
    expect(await db.shiftRequirement.count()).toBe(109 * 3)
  })

  it('stores the nurse demand the golden test predicts', async () => {
    const db = await getTestDb()
    const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyShiftImport(tx, result, { ...META, filename: 'shifts.csv' }), { timeout: 30_000 })

    const agg = await db.shiftRequirement.aggregate({
      _sum: { requiredCount: true }, where: { profession: 'NURSE' },
    })
    // 225, not 226: 5054 merges into 5053 and 5111 is accepted. See Task 7's golden test.
    expect(agg._sum.requiredCount).toBe(225)
  })
})
