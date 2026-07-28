import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { IMPORT_LEGEND } from '@/lib/import/legend'

const staffResult = runStaffImport(readFileSync('staff.csv', 'utf8'))
const shiftResult = runShiftImport(readFileSync('shifts.csv', 'utf8'))

/** Every distinct issue code the two real source files actually produce. */
const emitted = new Map<string, Set<string>>() // code -> observed severities
for (const row of [...staffResult.rows, ...shiftResult.rows]) {
  for (const issue of row.issues) {
    const severities = emitted.get(issue.code) ?? new Set<string>()
    severities.add(issue.severity)
    emitted.set(issue.code, severities)
  }
}

describe('IMPORT_LEGEND', () => {
  it('documents every issue code actually emitted by the real source files', () => {
    const legendCodes = new Set(IMPORT_LEGEND.map((d) => d.code))
    const undocumented = [...emitted.keys()].filter((code) => !legendCodes.has(code))
    expect(undocumented).toEqual([])
  })

  it('agrees with the severity actually observed for each emitted code', () => {
    const byCode = new Map(IMPORT_LEGEND.map((d) => [d.code, d]))
    for (const [code, severities] of emitted) {
      const descriptor = byCode.get(code)
      expect(descriptor, `no legend entry for emitted code "${code}"`).toBeDefined()
      expect([...severities]).toEqual([descriptor!.severity])
    }
  })

  it('has unique codes across the whole legend', () => {
    const codes = IMPORT_LEGEND.map((d) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  // Not every legend entry needs to be exercised by these two files —
  // AMBIGUOUS_DATE and BAD_ARITY legitimately never occur in this data but
  // must still be documented for manager-uploaded CSVs. We only assert
  // reachability in the emitted -> legend direction above.
})
