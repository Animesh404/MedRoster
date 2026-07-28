import { createIssue, type Issue, type Severity } from './issues'

export interface RuleContext { push(issue: Issue): void }

/**
 * Describes one issue code a field rule can emit: which CSV column it
 * governs, whether emitting it kills the row or repairs it, and a
 * manager-facing sentence for the Import Report legend (Amendment A).
 * `code` is unique across the whole registry.
 */
export interface RuleDescriptor {
  code: string
  field: string
  severity: Severity
  describe: string
}

export interface FieldRule<In, Out> {
  /** Every code this rule may emit — usually one repair and one fatal. */
  emits: RuleDescriptor[]
  /** Returns the coerced value, or null to reject the row. */
  run(input: In, ctx: RuleContext): Out | null
}

/**
 * Factory for a field rule. Rules are plain values — there is no
 * module-level mutable registry, since import-order-dependent global state
 * is not worth the convenience. Validates at construction that `emits` is
 * non-empty and that its codes are unique within the rule, so a rule can
 * never emit a code it didn't declare.
 */
export function createFieldRule<In, Out>(spec: FieldRule<In, Out>): FieldRule<In, Out> {
  if (spec.emits.length === 0) {
    throw new Error('createFieldRule: `emits` must declare at least one issue code.')
  }
  const seen = new Set<string>()
  for (const descriptor of spec.emits) {
    if (seen.has(descriptor.code)) {
      throw new Error(`createFieldRule: code "${descriptor.code}" is declared twice in the same rule's emits.`)
    }
    seen.add(descriptor.code)
  }
  return spec
}

/**
 * Shared core for `collectLegend` and `mergeLegends` below: flattens several
 * groups of descriptors into one legend, keyed by code, throwing if the same
 * code is registered twice with a different `describe`, `severity` or
 * `field` — two rules (or two whole pipelines) silently disagreeing about
 * what a code means, or which column it governs, is exactly the drift this
 * exists to prevent. Deliberately the ONE place this check is implemented,
 * so a same-rule collision and a cross-pipeline collision are caught the
 * same way instead of one throwing and the other being resolved silently
 * first-entry-wins.
 */
function mergeDescriptorGroups(groups: RuleDescriptor[][]): RuleDescriptor[] {
  const byCode = new Map<string, RuleDescriptor>()

  for (const group of groups) {
    for (const descriptor of group) {
      const existing = byCode.get(descriptor.code)
      if (existing === undefined) {
        byCode.set(descriptor.code, descriptor)
        continue
      }
      if (
        existing.describe !== descriptor.describe ||
        existing.severity !== descriptor.severity ||
        existing.field !== descriptor.field
      ) {
        throw new Error(
          `collectLegend: code "${descriptor.code}" is registered twice with conflicting text — ` +
          `field="${existing.field}" ${existing.severity} "${existing.describe}" vs ` +
          `field="${descriptor.field}" ${descriptor.severity} "${descriptor.describe}".`,
        )
      }
    }
  }

  return [...byCode.values()]
}

/**
 * Flattens and de-duplicates the `emits` lists of several rules into one
 * legend. See `mergeDescriptorGroups` for the conflict semantics.
 *
 * Takes a minimal structural type rather than `FieldRule<never, unknown>[]`:
 * this function only ever reads `rule.emits` and never touches `run`, so
 * there is no need for the `In`/`Out` generic-variance workaround at all.
 */
export function collectLegend(rules: { emits: RuleDescriptor[] }[]): RuleDescriptor[] {
  return mergeDescriptorGroups(rules.map((rule) => rule.emits))
}

/**
 * Merges several already-flat `RuleDescriptor[]` sources into one legend —
 * e.g. `RECONCILE_RULES`, `STRUCTURAL_RULES`, `SHIFT_WINDOW_RULES`, and the
 * flattened `emits` of `STAFF_RULES`/`SHIFT_RULES` — with the SAME
 * throw-on-conflict semantics as `collectLegend`. `lib/import/legend.ts`
 * uses this to assemble `IMPORT_LEGEND` so that a cross-pipeline code
 * collision (e.g. two pipelines both emitting `INVALID_ID` with different
 * text) fails the build the same way a same-rule collision does, rather
 * than being silently resolved first-entry-wins one module up.
 */
export function mergeLegends(...groups: RuleDescriptor[][]): RuleDescriptor[] {
  return mergeDescriptorGroups(groups)
}

/** Convenience for rules that repair a value in place and log the before/after. */
export function repairing<T>(
  ctx: RuleContext,
  code: string,
  field: string,
  message: string,
  before: T,
  after: T,
): T {
  if (String(before) !== String(after)) {
    ctx.push(createIssue(code, 'REPAIR', message, {
      field, before: String(before), after: String(after),
    }))
  }
  return after
}

/** Convenience for rules that kill the row. */
export function fatal(ctx: RuleContext, code: string, field: string, message: string, before?: string): null {
  ctx.push(createIssue(code, 'FATAL', message, before === undefined ? { field } : { field, before }))
  return null
}

/** Collects issues for one row. */
export function createRuleContext(): RuleContext & { issues: Issue[] } {
  const issues: Issue[] = []
  return { issues, push: (i) => { issues.push(i) } }
}

/**
 * Descriptors for genuinely STRUCTURAL issue codes: codes that fire before a
 * single cell can even be coerced, because the row itself is malformed (e.g.
 * the wrong number of columns). These are pushed directly via `ctx.push(...)`
 * outside of any single `FieldRule`, so they have no natural `In`/`Out` to
 * run one field rule over and are absent from `collectLegend`'s output.
 * `BAD_ARITY` (wrong column count) is the only member; both
 * `lib/import/staff.ts` and `lib/import/shifts.ts` emit it the same way.
 * Concatenate this into `IMPORT_LEGEND` alongside
 * `collectLegend([...STAFF_RULES, ...SHIFT_RULES])`, `SHIFT_WINDOW_RULES` and
 * `RECONCILE_RULES`.
 *
 * Do not add cross-field business-rule codes here — see `SHIFT_WINDOW_RULES`.
 */
export const STRUCTURAL_RULES: RuleDescriptor[] = [
  {
    code: 'BAD_ARITY',
    field: 'row',
    severity: 'FATAL',
    describe: 'Row does not have the expected number of columns and cannot be parsed.',
  },
]

/**
 * Descriptors for `lib/import/shifts.ts`'s cross-field, shift-window business
 * rules: `OVERNIGHT_ROLLOVER`, `EXPLICIT_NEXT_DAY` and `DURATION_TOO_LONG`.
 * These are NOT structural in the `STRUCTURAL_RULES` sense — the row is
 * perfectly well-formed and every individual cell coerces cleanly. They arise
 * only once the date, start time and end time have each already been coerced
 * and are then combined (via `resolveShiftWindow`), so no single-cell
 * `FieldRule` naturally owns them and they are pushed directly via
 * `ctx.push(...)` / `fatal`/`repairing` from `parseShiftRows` itself. Kept
 * separate from `STRUCTURAL_RULES` so a manager's Import Report legend does
 * not file "shift runs overnight" under a "structural" heading. Concatenate
 * this into `IMPORT_LEGEND` alongside `collectLegend([...STAFF_RULES,
 * ...SHIFT_RULES])`, `STRUCTURAL_RULES` and `RECONCILE_RULES`.
 */
export const SHIFT_WINDOW_RULES: RuleDescriptor[] = [
  {
    code: 'OVERNIGHT_ROLLOVER',
    field: 'end_time',
    severity: 'REPAIR',
    describe: 'End time is at or before the start time, so the shift was treated as running into the next day.',
  },
  {
    code: 'EXPLICIT_NEXT_DAY',
    field: 'end_time',
    severity: 'REPAIR',
    describe: 'End time carried an explicit "+1" suffix, so it was moved to the next day.',
  },
  {
    code: 'DURATION_TOO_LONG',
    field: 'end_time',
    severity: 'FATAL',
    describe: 'Shift duration is zero, negative, or exceeds the 12-hour maximum.',
  },
]

export type { Severity }
