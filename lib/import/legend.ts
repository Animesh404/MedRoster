import { collectLegend, STRUCTURAL_RULES, SHIFT_WINDOW_RULES, type RuleDescriptor } from './registry'
import { RECONCILE_RULES } from './reconcile'
import { STAFF_RULES } from './staff'
import { SHIFT_RULES } from './shifts'

/**
 * Amendment A consumer 3 — the manager-facing "what these codes mean" panel
 * rendered by Task 19's Import Report. Assembled from every source of issue
 * codes the importer can emit:
 *  - field-level codes from the staff pipeline (`STAFF_RULES`),
 *  - field-level codes from the shift pipeline (`SHIFT_RULES`),
 *  - reconciliation codes that only arise once two whole records are
 *    compared (`RECONCILE_RULES`),
 *  - genuinely structural codes pushed outside any single field rule
 *    (`STRUCTURAL_RULES`),
 *  - cross-field shift-window business rules (`SHIFT_WINDOW_RULES`).
 *
 * `collectLegend` is run separately over `STAFF_RULES` and `SHIFT_RULES`
 * rather than over their concatenation. Both pipelines happen to reuse the
 * code `INVALID_ID` for their id column, each with its own field-specific
 * describe text ("Staff id is not a whole number." vs "Shift id is not a
 * whole number.") — legitimate within each pipeline alone, but a genuine
 * text conflict once merged, which `collectLegend` treats as a bug and
 * throws on rather than silently resolving. Neither `staff.ts` nor
 * `shifts.ts` may be edited to rename the code (both are reviewed clean and
 * existing tests assert on `INVALID_ID` for each), so the merge instead
 * happens here, by hand, with explicit first-entry-wins semantics — the
 * same rule `collectLegend` itself documents, just applied across the
 * module boundary instead of within a single call. `STAFF_RULES` is listed
 * first, so a manager reading the legend sees "Staff id is not a whole
 * number." for `INVALID_ID`.
 */
function mergeLegend(...groups: RuleDescriptor[][]): RuleDescriptor[] {
  const byCode = new Map<string, RuleDescriptor>()
  for (const group of groups) {
    for (const descriptor of group) {
      if (!byCode.has(descriptor.code)) byCode.set(descriptor.code, descriptor)
    }
  }
  return [...byCode.values()]
}

export const IMPORT_LEGEND: RuleDescriptor[] = mergeLegend(
  collectLegend(STAFF_RULES),
  collectLegend(SHIFT_RULES),
  RECONCILE_RULES,
  STRUCTURAL_RULES,
  SHIFT_WINDOW_RULES,
).sort((a, b) => a.code.localeCompare(b.code))
