import { collectLegend, mergeLegends, STRUCTURAL_RULES, SHIFT_WINDOW_RULES, type RuleDescriptor } from './registry'
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
 * Both pipelines' `idRule` reuse the code `INVALID_ID` for their id column.
 * That used to be a genuine text conflict once merged (staff.ts said "Staff
 * id...", shifts.ts said "Shift id..."), which is exactly the drift
 * `collectLegend` exists to catch — so both descriptors were made
 * field-agnostic at the source (`field: 'staff_id / shift_id'`, `describe:
 * 'Id is not a whole number.'`), the same pattern already used for
 * `TIME_WHITESPACE`/`MISSING_TIME`/`BAD_TIME_FORMAT` in shifts.ts. Per-row
 * `Issue`s are unaffected — they still carry the pipeline-specific field and
 * message via each rule's `run` closure.
 *
 * With that fixed at the source, `mergeLegends` below can merge every source
 * with the SAME throw-on-conflict semantics `collectLegend` uses internally
 * for a single rule set — no first-entry-wins escape hatch. If a future rule
 * reintroduces a same-code/different-text collision across pipelines, this
 * throws at module load (build time), not silently documents the wrong
 * pipeline's text.
 */
export const IMPORT_LEGEND: RuleDescriptor[] = mergeLegends(
  collectLegend(STAFF_RULES),
  collectLegend(SHIFT_RULES),
  RECONCILE_RULES,
  STRUCTURAL_RULES,
  SHIFT_WINDOW_RULES,
).sort((a, b) => a.code.localeCompare(b.code))
