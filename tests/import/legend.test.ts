import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { IMPORT_LEGEND } from '@/lib/import/legend'
import { collectLegend, mergeLegends, type RuleDescriptor } from '@/lib/import/registry'
import { STAFF_RULES } from '@/lib/import/staff'
import { SHIFT_RULES } from '@/lib/import/shifts'

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

describe('cross-set collisions (Finding 1)', () => {
  // Regression: STAFF_RULES and SHIFT_RULES each declared their own
  // `INVALID_ID` descriptor with pipeline-specific text ("Staff id is not a
  // whole number." vs "Shift id is not a whole number."). `collectLegend`
  // already throws when the same code is declared twice with conflicting
  // text WITHIN one call, but the old `IMPORT_LEGEND` assembly merged
  // `collectLegend(STAFF_RULES)` and `collectLegend(SHIFT_RULES)` with a
  // hand-rolled first-entry-wins merge that swallowed exactly this
  // conflict — so a manager uploading a bad shifts.csv saw the STAFF text
  // ("Staff id is not a whole number.") for a SHIFT_ID problem. Both
  // descriptors are now field-agnostic at the source, and the merge step
  // (`mergeLegends`) now throws on conflict just like `collectLegend` does,
  // so this class of bug fails the build instead of shipping wrong text.

  it('mergeLegends throws when two sources register the same code with a different describe', () => {
    const a: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'one' }]
    const b: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'two' }]
    expect(() => mergeLegends(a, b)).toThrow()
  })

  it('mergeLegends throws when two sources register the same code with a different severity', () => {
    const a: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'one' }]
    const b: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'REPAIR', describe: 'one' }]
    expect(() => mergeLegends(a, b)).toThrow()
  })

  it('mergeLegends throws when two sources register the same code with a different field', () => {
    const a: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'one' }]
    const b: RuleDescriptor[] = [{ code: 'X', field: 'b', severity: 'FATAL', describe: 'one' }]
    expect(() => mergeLegends(a, b)).toThrow()
  })

  it('mergeLegends dedupes without throwing when two sources agree exactly', () => {
    const a: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'one' }]
    const b: RuleDescriptor[] = [{ code: 'X', field: 'a', severity: 'FATAL', describe: 'one' }]
    expect(mergeLegends(a, b)).toEqual(a)
  })

  it('STAFF_RULES and SHIFT_RULES declare an identical INVALID_ID descriptor', () => {
    const staffInvalidId = collectLegend(STAFF_RULES).find((d) => d.code === 'INVALID_ID')
    const shiftInvalidId = collectLegend(SHIFT_RULES).find((d) => d.code === 'INVALID_ID')
    expect(staffInvalidId).toBeDefined()
    expect(shiftInvalidId).toBeDefined()
    expect(staffInvalidId).toEqual(shiftInvalidId)
  })

  it('every code appearing in more than one rule set/registry agrees on describe, field and severity', () => {
    // General audit, not just INVALID_ID: enumerate every code across every
    // source IMPORT_LEGEND draws from, and fail if any code is declared more
    // than once with differing text anywhere in the registry.
    const sources: Record<string, RuleDescriptor[]> = {
      STAFF_RULES: collectLegend(STAFF_RULES),
      SHIFT_RULES: collectLegend(SHIFT_RULES),
    }
    const byCode = new Map<string, { source: string; d: RuleDescriptor }[]>()
    for (const [source, descriptors] of Object.entries(sources)) {
      for (const d of descriptors) {
        const arr = byCode.get(d.code) ?? []
        arr.push({ source, d })
        byCode.set(d.code, arr)
      }
    }
    const conflicts = [...byCode.entries()].filter(([, entries]) =>
      entries.some((e) => e.d.describe !== entries[0]!.d.describe ||
        e.d.severity !== entries[0]!.d.severity ||
        e.d.field !== entries[0]!.d.field),
    )
    expect(conflicts).toEqual([])
  })
})
