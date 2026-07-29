import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getExactOutcomeCounts } from '@/lib/import/report'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

/**
 * Regression for the Import Report's "% of rows kept" gauge and outcome bar
 * silently under-counting REJECTED (and every other outcome) once a run has
 * more rows than the page-walking loop that used to compute this would ever
 * reach (`app/(app)/import/[runId]/page.tsx`'s old `exactOutcomeCounts`
 * stopped after 100 pages of 100 — a hard 10,000-row ceiling). A single CSV
 * upload can clear that: with short rows, the 2 MB upload cap
 * (`app/api/imports/route.ts`'s `MAX_BYTES`) allows tens of thousands of
 * rows. `getExactOutcomeCounts` replaces the paged walk with one `groupBy`
 * aggregate, so this asserts it is exact for a run whose rows span many
 * pages — including REJECTED rows filed AFTER the point a paginated walk
 * with any fixed page-count ceiling would have stopped looking.
 */
describe('getExactOutcomeCounts', () => {
  it('returns zeros for a run with no rows', async () => {
    const db = await getTestDb()
    const run = await db.importRun.create({
      data: { source: 'UPLOAD', fileKind: 'SHIFT', filename: 'empty.csv', stats: { accepted: 0, merged: 0, rejected: 0, total: 0 } },
    })

    const counts = await getExactOutcomeCounts(db, run.id)
    expect(counts).toEqual({ accepted: 0, repaired: 0, merged: 0, rejected: 0, total: 0 })
  })

  it('counts every outcome exactly across many rows, including ones the row report would put on a later page', async () => {
    const db = await getTestDb()
    const run = await db.importRun.create({
      data: { source: 'UPLOAD', fileKind: 'SHIFT', filename: 'huge.csv', stats: { accepted: 0, merged: 0, rejected: 0, total: 0 } },
    })

    // 340 rows total, spread across all four outcomes, well past the
    // report table's own page size (25) and the API's max page size (100) —
    // and specifically with REJECTED rows positioned LAST, at rowNumbers
    // that a bug re-introducing any "stop after N pages" loop would be the
    // first outcome dropped.
    const accepted = 120
    const repaired = 80
    const merged = 100
    const rejected = 40

    await db.importRowResult.createMany({
      data: [
        ...Array.from({ length: accepted }, (_, i) => ({
          importRunId: run.id, rowNumber: i + 1, rawRow: `row-${i}`, outcome: 'ACCEPTED' as const, issues: [],
        })),
        ...Array.from({ length: repaired }, (_, i) => ({
          importRunId: run.id, rowNumber: accepted + i + 1, rawRow: `row-${i}`, outcome: 'REPAIRED' as const, issues: [],
        })),
        ...Array.from({ length: merged }, (_, i) => ({
          importRunId: run.id, rowNumber: accepted + repaired + i + 1, rawRow: `row-${i}`, outcome: 'MERGED' as const, issues: [],
        })),
        // Rejected rows filed last — the exact position a fixed-ceiling
        // pagination loop would fail to reach.
        ...Array.from({ length: rejected }, (_, i) => ({
          importRunId: run.id, rowNumber: accepted + repaired + merged + i + 1, rawRow: `row-${i}`, outcome: 'REJECTED' as const, issues: [],
        })),
      ],
    })

    const counts = await getExactOutcomeCounts(db, run.id)
    expect(counts).toEqual({
      accepted, repaired, merged, rejected,
      total: accepted + repaired + merged + rejected,
    })
  })
})
