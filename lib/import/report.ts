import type { PrismaClient } from '@prisma/client'

export interface OutcomeCounts {
  accepted: number
  repaired: number
  merged: number
  rejected: number
  total: number
}

const EMPTY: OutcomeCounts = { accepted: 0, repaired: 0, merged: 0, rejected: 0, total: 0 }

/**
 * Exact per-outcome counts for an entire import run, in one database
 * aggregate — not by paging through `ImportRowResult` via the row-report
 * endpoint and stopping after some fixed number of pages.
 *
 * `ImportRun.stats` (written at import time, see `lib/import/apply.ts`)
 * deliberately counts ACCEPTED and REPAIRED together (the right number for
 * "how many rows made it in"), so the Import Report's stacked outcome bar —
 * which needs the two split apart — cannot read it straight from there and
 * has to re-derive the split from the rows themselves.
 *
 * The Import Report page used to do that by walking `GET /api/imports/:runId`
 * with a hard "stop after 100 pages of 100" ceiling, on the theory that no
 * real run would ever be that big. A single CSV upload can land up to the
 * 2 MB size cap (`app/api/imports/route.ts`'s `MAX_BYTES`), which a run of
 * short rows clears well past 10,000 — a real upload that size silently had
 * every ACCEPTED/REPAIRED/MERGED/REJECTED row past the 10,000th one dropped
 * from the report's counts, understating (often to zero) how many rows
 * actually failed. `groupBy` reads every row belonging to the run in one
 * query regardless of how many there are, so there is no ceiling to exceed.
 */
export async function getExactOutcomeCounts(
  db: Pick<PrismaClient, 'importRowResult'>,
  runId: number,
): Promise<OutcomeCounts> {
  const grouped = await db.importRowResult.groupBy({
    by: ['outcome'],
    where: { importRunId: runId },
    _count: { _all: true },
  })

  const counts = { ...EMPTY }
  for (const g of grouped) {
    const n = g._count._all
    counts.total += n
    if (g.outcome === 'ACCEPTED') counts.accepted = n
    else if (g.outcome === 'REPAIRED') counts.repaired = n
    else if (g.outcome === 'MERGED') counts.merged = n
    else counts.rejected = n
  }
  return counts
}
