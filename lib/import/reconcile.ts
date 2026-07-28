import type { RowOutcome } from '@prisma/client'
import { createIssue, deriveOutcome, type Issue } from './issues'
import type { RuleDescriptor } from './registry'
import type { StaffRecord } from './staff'
import type { ShiftRecord } from './shifts'

export interface ImportedRow<T> {
  rowNumber: number
  raw: string
  outcome: RowOutcome
  issues: Issue[]
  record: T | null
  mergedIntoExternalId?: number
}

export interface ImportResult<T> {
  rows: ImportedRow<T>[]
  accepted: T[]
  stats: { accepted: number; merged: number; rejected: number; total: number }
}

interface ParsedRow<T> { rowNumber: number; raw: string; record: T | null; issues: Issue[] }

/** Identity of a record for "same thing filed twice" detection. */
type KeyFn<T> = (r: T) => string

/**
 * Amendment A consumer: reconciliation emits issue codes no field rule owns
 * (they only arise once two whole records are compared against each other,
 * not while a single cell is being coerced). Declared here so the legend in
 * `lib/import/legend.ts` documents them for a manager reading the Import
 * Report, exactly like `STAFF_RULES` / `SHIFT_RULES` document field-level
 * codes and `STRUCTURAL_RULES` / `SHIFT_WINDOW_RULES` document the rest.
 */
export const RECONCILE_RULES: RuleDescriptor[] = [
  {
    code: 'DUPLICATE_ROW',
    field: 'row',
    severity: 'REPAIR',
    describe: 'Row is byte-identical to an earlier row for the same id; the duplicate was dropped.',
  },
  {
    code: 'DUPLICATE_ID_CONFLICT',
    field: 'row',
    severity: 'REPAIR',
    describe: 'This id was already imported with different details; the first row filed under that id was kept.',
  },
  {
    code: 'DUPLICATE_PERSON',
    field: 'row',
    severity: 'REPAIR',
    describe: 'Same name and email as a staff member already imported under a different id; merged into the lower id.',
  },
  {
    code: 'EMAIL_COLLISION',
    field: 'email',
    severity: 'FATAL',
    describe: 'Email already belongs to a different staff member; emails are login identities and must be unique.',
  },
  {
    code: 'DUPLICATE_SHIFT',
    field: 'row',
    severity: 'REPAIR',
    describe: 'Same date, time and requirements as a shift already imported under a different id; merged into the lower id.',
  },
]

/**
 * Folds duplicate rows together. `keys` are tried in order; the first that
 * matches an already-accepted record merges the row into it.
 *
 * Where two rows collide, the survivor is the one with the LOWEST external id —
 * so Zainab Volkov filed as both 999 and 105 survives as 105, the in-range id.
 * Because that decision can retroactively replace an already-accepted record,
 * reconciliation runs over rows pre-sorted by external id.
 */
function reconcile<T extends { externalId: number }>(
  parsed: ParsedRow<T>[],
  keys: KeyFn<T>[],
  onCollision: (incoming: T, existing: T, issues: Issue[]) => 'MERGE' | 'REJECT',
): ImportResult<T> {
  const accepted = new Map<number, T>()          // externalId -> record
  const index = new Map<string, number>()        // key -> externalId
  const rows: ImportedRow<T>[] = []

  // Lowest external id wins, so process in id order and let the first arrival stand.
  const order = [...parsed].sort((a, b) => {
    const ai = a.record?.externalId ?? Number.MAX_SAFE_INTEGER
    const bi = b.record?.externalId ?? Number.MAX_SAFE_INTEGER
    return ai - bi || a.rowNumber - b.rowNumber
  })

  for (const row of order) {
    const issues = [...row.issues]

    if (row.record === null) {
      rows.push({ rowNumber: row.rowNumber, raw: row.raw, issues, outcome: deriveOutcome(issues, false), record: null })
      continue
    }

    let hitId: number | undefined
    for (const key of keys) {
      const found = index.get(key(row.record))
      if (found !== undefined) { hitId = found; break }
    }

    if (hitId === undefined) {
      accepted.set(row.record.externalId, row.record)
      for (const key of keys) index.set(key(row.record), row.record.externalId)
      rows.push({ rowNumber: row.rowNumber, raw: row.raw, issues, outcome: deriveOutcome(issues, false), record: row.record })
      continue
    }

    const existing = accepted.get(hitId)!
    const decision = onCollision(row.record, existing, issues)

    if (decision === 'REJECT') {
      rows.push({ rowNumber: row.rowNumber, raw: row.raw, issues, outcome: deriveOutcome(issues, false), record: null })
    } else {
      // Index the merged-away row's OWN keys too (not just the survivor's),
      // pointing at the survivor's external id. Without this, a THIRD row
      // that reuses this row's id (or email) — e.g. a second duplicate of
      // staff 999 filed with a typo'd email — would find nothing in `index`
      // (999's id key was never added, only 105's was), fall through to the
      // "new record" branch, and get accepted afresh under an id that was
      // already supposed to have been merged away. `if (!index.has(k))`
      // guards against clobbering a DIFFERENT existing survivor's key.
      for (const key of keys) {
        const k = key(row.record)
        if (!index.has(k)) index.set(k, hitId)
      }
      rows.push({
        rowNumber: row.rowNumber, raw: row.raw, issues, record: null,
        outcome: deriveOutcome(issues, true),
        mergedIntoExternalId: hitId,
      })
    }
  }

  // Report rows in file order even though reconciliation ran in id order.
  rows.sort((a, b) => a.rowNumber - b.rowNumber)

  const stats = {
    accepted: rows.filter((r) => r.outcome === 'ACCEPTED' || r.outcome === 'REPAIRED').length,
    merged: rows.filter((r) => r.outcome === 'MERGED').length,
    rejected: rows.filter((r) => r.outcome === 'REJECTED').length,
    total: rows.length,
  }

  return { rows, accepted: [...accepted.values()], stats }
}

export function reconcileStaff(parsed: ParsedRow<StaffRecord>[]): ImportResult<StaffRecord> {
  return reconcile<StaffRecord>(
    parsed,
    [
      (r) => `id:${r.externalId}`,
      (r) => `email:${r.email}`,
    ],
    (incoming, existing, issues) => {
      if (incoming.externalId === existing.externalId) {
        const identical =
          incoming.name === existing.name &&
          incoming.email === existing.email &&
          incoming.profession === existing.profession
        issues.push(createIssue(
          identical ? 'DUPLICATE_ROW' : 'DUPLICATE_ID_CONFLICT',
          'REPAIR',
          identical
            ? `Identical to the earlier row for staff ${existing.externalId}; kept one.`
            : `Staff ${existing.externalId} already imported with different details; kept the first row.`,
          { before: JSON.stringify(incoming), after: JSON.stringify(existing) },
        ))
        return 'MERGE'
      }

      // Same email, different id. Same human -> merge. Different human -> reject.
      if (incoming.name === existing.name) {
        issues.push(createIssue('DUPLICATE_PERSON', 'REPAIR',
          `Same person as staff ${existing.externalId}; merged into the lower id.`,
          { before: String(incoming.externalId), after: String(existing.externalId) }))
        return 'MERGE'
      }

      issues.push(createIssue('EMAIL_COLLISION', 'FATAL',
        `Email already belongs to ${existing.name} (staff ${existing.externalId}); ` +
        'emails are login identities and must be unique.',
        { field: 'email', before: incoming.email }))
      return 'REJECT'
    },
  )
}

export function reconcileShifts(parsed: ParsedRow<ShiftRecord>[]): ImportResult<ShiftRecord> {
  // The slot key deliberately INCLUDES requirements. Keying on date+time alone
  // would collapse the 24 legitimate same-slot groups described in §2.2.
  const slotKey = (r: ShiftRecord) =>
    `slot:${r.startsAt.toISOString()}|${r.endsAt.toISOString()}` +
    `|${r.requirements.DOCTOR},${r.requirements.NURSE},${r.requirements.RECEPTIONIST}`

  return reconcile<ShiftRecord>(
    parsed,
    [(r) => `id:${r.externalId}`, slotKey],
    (incoming, existing, issues) => {
      issues.push(createIssue(
        incoming.externalId === existing.externalId ? 'DUPLICATE_ROW' : 'DUPLICATE_SHIFT',
        'REPAIR',
        `Same date, time and requirements as shift ${existing.externalId}; kept the lower id.`,
        { before: String(incoming.externalId), after: String(existing.externalId) },
      ))
      return 'MERGE'
    },
  )
}
