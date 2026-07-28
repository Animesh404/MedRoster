import type { RowOutcome } from '@prisma/client'

export type Severity = 'REPAIR' | 'FATAL'

export interface Issue {
  code: string
  severity: Severity
  message: string
  field?: string
  before?: string
  after?: string
}

/** Sole constructor for issues, so every logged decision has the same shape. */
export function createIssue(
  code: string,
  severity: Severity,
  message: string,
  opts: { field?: string; before?: string; after?: string } = {},
): Issue {
  return { code, severity, message, ...opts }
}

/**
 * Outcome is derived from what happened, never assigned by hand (§5.1).
 * Precedence: any FATAL wins, then a merge, then a repair, else clean.
 */
export function deriveOutcome(issues: Issue[], merged: boolean): RowOutcome {
  if (issues.some((i) => i.severity === 'FATAL')) return 'REJECTED'
  if (merged) return 'MERGED'
  if (issues.length > 0) return 'REPAIRED'
  return 'ACCEPTED'
}
