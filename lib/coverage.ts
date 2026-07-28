import type { Profession } from '@prisma/client'

export type CoverageStatus = 'FULL' | 'PARTIAL' | 'EMPTY'

export interface Coverage {
  status: CoverageStatus
  /** How many more of each profession the shift still needs. Never negative. */
  missing: Record<Profession, number>
}

const PROFESSIONS: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']

/**
 * Single definition of a shift's staffing status, shared by the API, the week
 * grid and the shift detail page so the three can never disagree (§8.2).
 */
export function computeCoverage(
  requirements: Record<Profession, number>,
  claims: Record<Profession, number>,
): Coverage {
  const missing: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  let filled = 0
  let required = 0

  for (const p of PROFESSIONS) {
    const need = requirements[p]
    const have = claims[p]
    missing[p] = Math.max(0, need - have)
    required += need
    filled += Math.min(need, have)
  }

  const status: CoverageStatus =
    filled === 0 ? 'EMPTY' : filled >= required ? 'FULL' : 'PARTIAL'

  return { status, missing }
}
