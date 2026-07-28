import { createIssue, type Issue, type Severity } from './issues'

export interface RuleContext { push(issue: Issue): void }

export interface FieldRule<In, Out> {
  /** Stable identifier, also used as the issue code and as the test-case name. */
  code: string
  /** Human sentence for the import report legend. */
  describe: string
  /** Returns the coerced value, or null to reject the row. */
  run(input: In, ctx: RuleContext): Out | null
}

/**
 * Factory for a field rule. Rules are declared once here and reused by the
 * pipeline, the generated test suite and the import-report legend (§5.1),
 * so a rule can never exist in one of those three places but not the others.
 */
export function createFieldRule<In, Out>(spec: FieldRule<In, Out>): FieldRule<In, Out> {
  return spec
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

export type { Severity }
