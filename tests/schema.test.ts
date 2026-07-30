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
 * Earlier versions of this test concatenated every migration file's raw text
 * and regex-matched over the union. That only proves a constraint existed at
 * *some point* in history: a later migration that DROPs an index or
 * constraint would leave the original CREATE text sitting in the
 * concatenation, and every assertion would keep passing even though the
 * constraint no longer holds. Instead, `applyMigrations` folds the
 * migrations — applied in filename (timestamp-prefixed) order — into the net
 * schema state (which tables/indexes/constraints currently exist), the same
 * way Postgres would after replaying every migration.sql in order. All
 * assertions below run against that folded state, not the raw concatenation.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations')

function readMigrationFilesInOrder(migrationsDir: string): string[] {
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  if (dirs.length === 0) {
    throw new Error(`No migration directories found under ${migrationsDir}`)
  }

  return dirs.map((dir) => readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf-8'))
}

/** Net state of the schema after applying a sequence of migration.sql files in order. */
interface MigrationState {
  readonly tables: ReadonlyMap<string, string>
  readonly indexes: ReadonlyMap<string, string>
  readonly constraints: ReadonlyMap<string, string>
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>
}

function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

const CREATE_TABLE_RE = /^CREATE TABLE "([^"]+)"\s*\(([\s\S]*)\)$/
const DROP_TABLE_RE = /^DROP TABLE (?:IF EXISTS )?"([^"]+)"(?:\s+CASCADE)?$/i
const CREATE_INDEX_RE = /^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON /
const DROP_INDEX_RE = /^DROP INDEX (?:IF EXISTS )?"([^"]+)"$/i
const ADD_CONSTRAINT_RE = /^ALTER TABLE "[^"]+" ADD CONSTRAINT "([^"]+)"/
const DROP_CONSTRAINT_RE = /^ALTER TABLE "[^"]+" DROP CONSTRAINT "([^"]+)"$/i
const ADD_COLUMN_RE = /^ALTER TABLE "([^"]+)" ADD COLUMN\s+/i
const DROP_COLUMN_RE = /^ALTER TABLE "([^"]+)" DROP COLUMN\s+/i
// Prisma emits multiple ADD COLUMN / DROP COLUMN clauses comma-joined inside a
// single ALTER TABLE statement when a schema change touches more than one
// column on the same table (e.g. adding two columns at once). These match
// every clause in the statement, not just the first.
const ADD_COLUMN_NAME_RE = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/gi
const DROP_COLUMN_NAME_RE = /DROP COLUMN\s+(?:IF EXISTS\s+)?"([^"]+)"/gi

/**
 * Pure fold over a sequence of migration.sql file contents (in the order
 * they'd be applied) into the resulting schema state.
 *
 * A later DROP undoes an earlier CREATE of the same name instead of both
 * surviving side by side, which is the property a plain concatenate-and-regex
 * search over the raw text cannot give you.
 *
 * This is deliberately minimal, test infrastructure rather than a SQL parser:
 * it only understands the handful of DDL shapes Prisma's migration generator
 * emits and that the assertions in this file need — CREATE/DROP TABLE,
 * CREATE/DROP INDEX (including UNIQUE), ALTER TABLE ADD/DROP CONSTRAINT, and
 * ALTER TABLE ADD/DROP COLUMN, including Prisma's own comma-joined
 * multi-column form (`ADD COLUMN "a" ..., ADD COLUMN "b" ...` in one
 * statement) — every column clause in the statement is recorded, not just
 * the first. Anything else (e.g. ALTER COLUMN) is ignored.
 */
function applyMigrations(sqlFiles: readonly string[]): MigrationState {
  const tables = new Map<string, string>()
  const indexes = new Map<string, string>()
  const constraints = new Map<string, string>()
  const columns = new Map<string, Set<string>>()

  for (const fileContent of sqlFiles) {
    const statements = splitStatements(stripSqlComments(fileContent))

    for (const statement of statements) {
      const createTable = statement.match(CREATE_TABLE_RE)
      if (createTable?.[1] !== undefined && createTable[2] !== undefined) {
        tables.set(createTable[1], createTable[2])
        // Column names are the leading quoted identifier of each line in the
        // table body. Same deliberately-minimal parsing as the rest of this
        // helper — enough for Prisma's generated DDL, not a SQL parser.
        columns.set(
          createTable[1],
          new Set([...createTable[2].matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]!)),
        )
        continue
      }

      const dropTable = statement.match(DROP_TABLE_RE)
      if (dropTable?.[1] !== undefined) {
        tables.delete(dropTable[1])
        columns.delete(dropTable[1])
        continue
      }

      const createIndex = statement.match(CREATE_INDEX_RE)
      if (createIndex?.[1] !== undefined) {
        indexes.set(createIndex[1], statement)
        continue
      }

      const dropIndex = statement.match(DROP_INDEX_RE)
      if (dropIndex?.[1] !== undefined) {
        indexes.delete(dropIndex[1])
        continue
      }

      const addColumn = statement.match(ADD_COLUMN_RE)
      if (addColumn?.[1] !== undefined) {
        const existing = columns.get(addColumn[1]) ?? new Set<string>()
        for (const name of statement.matchAll(ADD_COLUMN_NAME_RE)) existing.add(name[1]!)
        columns.set(addColumn[1], existing)
        continue
      }

      const dropColumn = statement.match(DROP_COLUMN_RE)
      if (dropColumn?.[1] !== undefined) {
        const existing = columns.get(dropColumn[1])
        for (const name of statement.matchAll(DROP_COLUMN_NAME_RE)) existing?.delete(name[1]!)
        continue
      }

      const addConstraint = statement.match(ADD_CONSTRAINT_RE)
      if (addConstraint?.[1] !== undefined) {
        constraints.set(addConstraint[1], statement)
        continue
      }

      const dropConstraint = statement.match(DROP_CONSTRAINT_RE)
      if (dropConstraint?.[1] !== undefined) {
        constraints.delete(dropConstraint[1])
        continue
      }
    }
  }

  return { tables, indexes, constraints, columns }
}

function requireTable(state: MigrationState, name: string): string {
  const body = state.tables.get(name)
  if (body === undefined) {
    throw new Error(`no surviving CREATE TABLE "${name}" after folding all migrations`)
  }
  return body
}

function requireIndex(state: MigrationState, name: string): string {
  const statement = state.indexes.get(name)
  if (statement === undefined) {
    throw new Error(`no surviving index "${name}" after folding all migrations`)
  }
  return statement
}

function requireConstraint(state: MigrationState, name: string): string {
  const statement = state.constraints.get(name)
  if (statement === undefined) {
    throw new Error(`no surviving constraint "${name}" after folding all migrations`)
  }
  return statement
}

const state = applyMigrations(readMigrationFilesInOrder(MIGRATIONS_DIR))

describe('applied migration SQL (folded to net state)', () => {
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
      expect(state.tables.has(table), `missing CREATE TABLE "${table}"`).toBe(true)
    }
  })

  it('makes a user unable to hold the same shift twice', () => {
    expect(requireIndex(state, 'Claim_shiftId_userId_key')).toMatch(
      /CREATE UNIQUE INDEX "Claim_shiftId_userId_key" ON "Claim"\("shiftId", "userId"\)/,
    )
  })

  it('allows only one requirement row per profession per shift', () => {
    expect(requireIndex(state, 'ShiftRequirement_shiftId_profession_key')).toMatch(
      /CREATE UNIQUE INDEX "ShiftRequirement_shiftId_profession_key" ON "ShiftRequirement"\("shiftId", "profession"\)/,
    )
  })

  it('versions shifts so edit previews can detect concurrent writes', () => {
    expect(requireTable(state, 'Shift')).toMatch(/"version"\s+INTEGER\s+NOT NULL/)
  })

  it('lets the CSV importer upsert users and shifts on their external id', () => {
    expect(requireIndex(state, 'User_externalId_key')).toMatch(
      /CREATE UNIQUE INDEX "User_externalId_key" ON "User"\("externalId"\)/,
    )
    expect(requireIndex(state, 'Shift_externalId_key')).toMatch(
      /CREATE UNIQUE INDEX "Shift_externalId_key" ON "Shift"\("externalId"\)/,
    )
  })

  it('cascades shift deletion to its claims and requirements', () => {
    expect(requireConstraint(state, 'Claim_shiftId_fkey')).toMatch(
      /ALTER TABLE "Claim" ADD CONSTRAINT "Claim_shiftId_fkey" FOREIGN KEY \("shiftId"\) REFERENCES "Shift"\("id"\) ON DELETE CASCADE/,
    )
    expect(requireConstraint(state, 'ShiftRequirement_shiftId_fkey')).toMatch(
      /ALTER TABLE "ShiftRequirement" ADD CONSTRAINT "ShiftRequirement_shiftId_fkey" FOREIGN KEY \("shiftId"\) REFERENCES "Shift"\("id"\) ON DELETE CASCADE/,
    )
  })

  it('links a profile to its Supabase auth user, uniquely and optionally', () => {
    expect(state.columns.get('User')?.has('authUserId')).toBe(true)
    expect(state.indexes.has('User_authUserId_key'), 'authUserId must be unique').toBe(true)
  })

  it('records when a member was deactivated', () => {
    expect(state.columns.get('User')?.has('deactivatedAt')).toBe(true)
  })
})

describe('applyMigrations folding semantics (regression guard)', () => {
  it('a later DROP INDEX removes an earlier CREATE UNIQUE INDEX from the folded state', () => {
    const dropped = applyMigrations([
      '-- CreateIndex\nCREATE UNIQUE INDEX "Claim_shiftId_userId_key" ON "Claim"("shiftId", "userId");',
      '-- DropIndex\nDROP INDEX "Claim_shiftId_userId_key";',
    ])

    expect(dropped.indexes.has('Claim_shiftId_userId_key')).toBe(false)
  })

  it('a later DROP CONSTRAINT removes an earlier ADD CONSTRAINT (ON DELETE CASCADE) from the folded state', () => {
    const dropped = applyMigrations([
      '-- AddForeignKey\nALTER TABLE "Claim" ADD CONSTRAINT "Claim_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      '-- DropForeignKey\nALTER TABLE "Claim" DROP CONSTRAINT "Claim_shiftId_fkey";',
    ])

    expect(dropped.constraints.has('Claim_shiftId_fkey')).toBe(false)
  })

  it('a later DROP TABLE removes an earlier CREATE TABLE from the folded state', () => {
    const dropped = applyMigrations([
      '-- CreateTable\nCREATE TABLE "Scratch" (\n    "id" SERIAL NOT NULL,\n\n    CONSTRAINT "Scratch_pkey" PRIMARY KEY ("id")\n);',
      '-- DropTable\nDROP TABLE "Scratch";',
    ])

    expect(dropped.tables.has('Scratch')).toBe(false)
  })

  it('a later CREATE re-adds an index that an intervening DROP removed', () => {
    const recreated = applyMigrations([
      'CREATE INDEX "Foo_bar_idx" ON "Foo"("bar");',
      'DROP INDEX "Foo_bar_idx";',
      'CREATE INDEX "Foo_bar_idx" ON "Foo"("bar");',
    ])

    expect(recreated.indexes.has('Foo_bar_idx')).toBe(true)
  })

  it('a later DROP COLUMN undoes an earlier ADD COLUMN', () => {
    const folded = applyMigrations([
      'CREATE TABLE "T" (\n  "id" INTEGER NOT NULL\n);',
      'ALTER TABLE "T" ADD COLUMN "temp" TEXT;',
      'ALTER TABLE "T" DROP COLUMN "temp";',
    ])
    expect(folded.columns.get('T')?.has('id')).toBe(true)
    expect(folded.columns.get('T')?.has('temp')).toBe(false)
  })

  it('a single ALTER TABLE statement adding two columns records both (Prisma\'s own multi-column style)', () => {
    const folded = applyMigrations([
      'CREATE TABLE "T" (\n  "id" INTEGER NOT NULL\n);',
      'ALTER TABLE "T" ADD COLUMN     "a" TEXT,\nADD COLUMN     "b" TEXT;',
    ])
    expect(folded.columns.get('T')?.has('a')).toBe(true)
    expect(folded.columns.get('T')?.has('b')).toBe(true)
  })

  it('a single ALTER TABLE statement dropping two columns removes both', () => {
    const folded = applyMigrations([
      'CREATE TABLE "T" (\n  "id" INTEGER NOT NULL,\n  "a" TEXT,\n  "b" TEXT\n);',
      'ALTER TABLE "T" DROP COLUMN "a",\nDROP COLUMN "b";',
    ])
    expect(folded.columns.get('T')?.has('a')).toBe(false)
    expect(folded.columns.get('T')?.has('b')).toBe(false)
  })

  it('the real migration history does not currently drop the invariants under test', () => {
    // Sanity check that folding the actual migrations directory produces the
    // same names as the raw-concatenation approach did — i.e. nothing here
    // has actually regressed today. The point of this suite is that it WOULD
    // catch it if something did.
    expect(state.indexes.has('Claim_shiftId_userId_key')).toBe(true)
    expect(state.constraints.has('Claim_shiftId_fkey')).toBe(true)
  })
})
