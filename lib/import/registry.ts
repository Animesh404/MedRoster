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
 * Flattens and de-duplicates the `emits` lists of several rules into one
 * legend, keyed by code. Throws if the same code is registered by two
 * rules with a different `describe` or `severity` — two rules silently
 * disagreeing about what a code means is exactly the drift this exists to
 * prevent.
 *
 * Takes a minimal structural type rather than `FieldRule<never, unknown>[]`:
 * this function only ever reads `rule.emits` and never touches `run`, so
 * there is no need for the `In`/`Out` generic-variance workaround at all.
 */
export function collectLegend(rules: { emits: RuleDescriptor[] }[]): RuleDescriptor[] {
  const byCode = new Map<string, RuleDescriptor>()

  for (const rule of rules) {
    for (const descriptor of rule.emits) {
      const existing = byCode.get(descriptor.code)
      if (existing === undefined) {
        byCode.set(descriptor.code, descriptor)
        continue
      }
      if (existing.describe !== descriptor.describe || existing.severity !== descriptor.severity) {
        throw new Error(
          `collectLegend: code "${descriptor.code}" is registered twice with conflicting text — ` +
          `"${existing.describe}" (${existing.severity}) vs "${descriptor.describe}" (${descriptor.severity}).`,
        )
      }
    }
  }

  return [...byCode.values()]
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
 * Descriptors for issue codes that a pipeline emits directly via
 * `ctx.push(...)` (or `fatal`/`repairing`) outside of any single `FieldRule`
 * — codes that either fire before a single cell can be coerced, or depend on
 * combining several already-coerced fields, so they have no natural
 * `In`/`Out` to run one field rule over. `BAD_ARITY` (wrong column count) is
 * the first of these; both `lib/import/staff.ts` and `lib/import/shifts.ts`
 * emit it the same way. `lib/import/shifts.ts` additionally emits
 * `OVERNIGHT_ROLLOVER`, `EXPLICIT_NEXT_DAY` and `DURATION_TOO_LONG` this way:
 * all three depend on the combination of the date, start time and end time
 * (via `resolveShiftWindow`), not on any one cell in isolation. Without an
 * entry here, these codes would reach a manager's Import Report with no
 * explanation, since `collectLegend` only sees `FieldRule.emits`. Concatenate
 * this into `IMPORT_LEGEND` alongside `collectLegend([...STAFF_RULES,
 * ...SHIFT_RULES])` and `RECONCILE_RULES`.
 */
export const STRUCTURAL_RULES: RuleDescriptor[] = [
  {
    code: 'BAD_ARITY',
    field: 'row',
    severity: 'FATAL',
    describe: 'Row does not have the expected number of columns and cannot be parsed.',
  },
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
