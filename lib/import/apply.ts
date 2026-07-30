import type { ImportSource, Prisma } from '@prisma/client'
import type { ImportResult } from './reconcile'
import type { StaffRecord } from './staff'
import type { ShiftRecord } from './shifts'

export interface ImportMeta {
  source: ImportSource
  filename: string
  actorId?: number
}

/** Writes the ImportRun plus one ImportRowResult per source line. */
async function writeRun<T>(
  tx: Prisma.TransactionClient,
  result: ImportResult<T>,
  meta: ImportMeta,
  fileKind: 'STAFF' | 'SHIFT',
  entityIdFor: (row: ImportResult<T>['rows'][number]) => number | null,
): Promise<number> {
  const run = await tx.importRun.create({
    data: {
      source: meta.source,
      fileKind,
      filename: meta.filename,
      actorId: meta.actorId ?? null,
      stats: result.stats,
    },
  })

  await tx.importRowResult.createMany({
    data: result.rows.map((row) => ({
      importRunId: run.id,
      rowNumber: row.rowNumber,
      rawRow: row.raw,
      outcome: row.outcome,
      issues: row.issues as unknown as Prisma.InputJsonValue,
      entityId: entityIdFor(row),
    })),
  })

  return run.id
}

export async function applyStaffImport(
  tx: Prisma.TransactionClient,
  result: ImportResult<StaffRecord>,
  meta: ImportMeta,
): Promise<number> {
  for (const record of result.accepted) {
    await tx.user.upsert({
      where: { externalId: record.externalId },
      create: {
        externalId: record.externalId,
        email: record.email,
        name: record.name,
        role: 'STAFF',
        profession: record.profession,
      },
      update: {
        email: record.email,
        name: record.name,
        profession: record.profession,
      },
    })
  }

  const byExternalId = new Map(
    (await tx.user.findMany({
      where: { externalId: { in: result.accepted.map((r) => r.externalId) } },
      select: { id: true, externalId: true },
    })).map((u) => [u.externalId!, u.id]),
  )

  return writeRun(tx, result, meta, 'STAFF', (row) =>
    row.record ? byExternalId.get(row.record.externalId) ?? null : null)
}

export async function applyShiftImport(
  tx: Prisma.TransactionClient,
  result: ImportResult<ShiftRecord>,
  meta: ImportMeta,
): Promise<number> {
  for (const record of result.accepted) {
    const shift = await tx.shift.upsert({
      where: { externalId: record.externalId },
      create: { externalId: record.externalId, startsAt: record.startsAt, endsAt: record.endsAt },
      update: { startsAt: record.startsAt, endsAt: record.endsAt },
    })

    for (const [profession, requiredCount] of Object.entries(record.requirements)) {
      await tx.shiftRequirement.upsert({
        where: { shiftId_profession: { shiftId: shift.id, profession: profession as never } },
        create: { shiftId: shift.id, profession: profession as never, requiredCount },
        update: { requiredCount },
      })
    }
  }

  const byExternalId = new Map(
    (await tx.shift.findMany({
      where: { externalId: { in: result.accepted.map((r) => r.externalId) } },
      select: { id: true, externalId: true },
    })).map((s) => [s.externalId!, s.id]),
  )

  return writeRun(tx, result, meta, 'SHIFT', (row) =>
    row.record ? byExternalId.get(row.record.externalId) ?? null : null)
}
