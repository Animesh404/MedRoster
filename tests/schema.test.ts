import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * This test asserts against the *applied* migration SQL under each
 * `prisma/migrations/<dir>/migration.sql` instead of re-parsing `schema.prisma`.
 *
 * Reparsing the schema only proves schema.prisma *declares* the right
 * constraints — it can't catch drift between schema.prisma and the migration
 * that was actually generated and applied to the database. Asserting on the
 * generated SQL closes that gap, and it's what later tasks (the double-claim
 * race guard, the CSV upsert-on-externalId importer) actually depend on at
 * runtime.
 *
 * All migration directories are read and concatenated in filename
 * (timestamp-prefixed) order, so this test does not hardcode a single
 * migration and will not rot when a later migration adds or alters columns.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations')

function readAllMigrationSql(): string {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  if (dirs.length === 0) {
    throw new Error(`No migration directories found under ${MIGRATIONS_DIR}`)
  }

  return dirs
    .map((dir) => readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8'))
    .join('\n')
}

const sql = readAllMigrationSql()

/** Returns the column/constraint body of a table's CREATE TABLE statement. */
function tableBody(table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\);`))
  if (!match || match[1] === undefined) {
    throw new Error(`CREATE TABLE "${table}" not found in any applied migration`)
  }
  return match[1]
}

describe('applied migration SQL', () => {
  it('defines every model the spec requires', () => {
    for (const table of [
      'User',
      'Shift',
      'ShiftRequirement',
      'Claim',
      'ShiftSeries',
      'ImportRun',
      'ImportRowResult',
      'EventOutbox',
    ]) {
      expect(sql, `missing CREATE TABLE "${table}"`).toMatch(new RegExp(`CREATE TABLE "${table}" \\(`))
    }
  })

  it('makes a user unable to hold the same shift twice', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Claim_shiftId_userId_key" ON "Claim"\("shiftId", "userId"\)/)
  })

  it('allows only one requirement row per profession per shift', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "ShiftRequirement_shiftId_profession_key" ON "ShiftRequirement"\("shiftId", "profession"\)/,
    )
  })

  it('versions shifts so edit previews can detect concurrent writes', () => {
    expect(tableBody('Shift')).toMatch(/"version"\s+INTEGER\s+NOT NULL/)
  })

  it('lets the CSV importer upsert users and shifts on their external id', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "User_externalId_key" ON "User"\("externalId"\)/)
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Shift_externalId_key" ON "Shift"\("externalId"\)/)
  })

  it('cascades shift deletion to its claims and requirements', () => {
    expect(sql).toMatch(
      /ALTER TABLE "Claim" ADD CONSTRAINT "Claim_shiftId_fkey" FOREIGN KEY \("shiftId"\) REFERENCES "Shift"\("id"\) ON DELETE CASCADE/,
    )
    expect(sql).toMatch(
      /ALTER TABLE "ShiftRequirement" ADD CONSTRAINT "ShiftRequirement_shiftId_fkey" FOREIGN KEY \("shiftId"\) REFERENCES "Shift"\("id"\) ON DELETE CASCADE/,
    )
  })
})
