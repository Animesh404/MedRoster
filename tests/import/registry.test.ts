import { describe, expect, it } from 'vitest'
import {
  collectLegend,
  createFieldRule,
  createRuleContext,
  fatal,
  repairing,
  type RuleContext,
} from '@/lib/import/registry'

const rule = (input: string, ctx: RuleContext): string | null =>
  input === '' ? fatal(ctx, 'BLANK', 'field', 'blank') : repairing(ctx, 'TRIM', 'field', 'trimmed', input, input.trim())

describe('createFieldRule', () => {
  it('throws when emits is empty — a rule must declare what it can emit', () => {
    expect(() => createFieldRule({ emits: [], run: rule })).toThrow()
  })

  it('throws when the same code is declared twice within one rule', () => {
    expect(() =>
      createFieldRule({
        emits: [
          { code: 'DUP', field: 'field', severity: 'FATAL', describe: 'first' },
          { code: 'DUP', field: 'field', severity: 'REPAIR', describe: 'second' },
        ],
        run: rule,
      }),
    ).toThrow()
  })

  it('returns the spec unchanged when it is valid', () => {
    const spec = {
      emits: [{ code: 'TRIM', field: 'field', severity: 'REPAIR' as const, describe: 'Trims whitespace.' }],
      run: rule,
    }
    expect(createFieldRule(spec)).toBe(spec)
  })
})

describe('collectLegend', () => {
  const ruleA = createFieldRule({
    emits: [
      { code: 'A_FATAL', field: 'a', severity: 'FATAL' as const, describe: 'A is broken.' },
      { code: 'A_REPAIR', field: 'a', severity: 'REPAIR' as const, describe: 'A was fixed.' },
    ],
    run: rule,
  })
  const ruleB = createFieldRule({
    emits: [{ code: 'B_FATAL', field: 'b', severity: 'FATAL' as const, describe: 'B is broken.' }],
    run: rule,
  })

  it('flattens emits across multiple rules', () => {
    const legend = collectLegend([ruleA, ruleB])
    expect(legend.map((d) => d.code).sort()).toEqual(['A_FATAL', 'A_REPAIR', 'B_FATAL'])
  })

  it('de-duplicates identical descriptors registered by more than one rule', () => {
    const legend = collectLegend([ruleA, ruleA])
    expect(legend.filter((d) => d.code === 'A_FATAL')).toHaveLength(1)
  })

  it('throws when two rules register the same code with a different describe', () => {
    const conflicting = createFieldRule({
      emits: [{ code: 'A_FATAL', field: 'a', severity: 'FATAL' as const, describe: 'A different story entirely.' }],
      run: rule,
    })
    expect(() => collectLegend([ruleA, conflicting])).toThrow()
  })

  it('throws when two rules register the same code with a different severity', () => {
    const conflicting = createFieldRule({
      emits: [{ code: 'A_FATAL', field: 'a', severity: 'REPAIR' as const, describe: 'A is broken.' }],
      run: rule,
    })
    expect(() => collectLegend([ruleA, conflicting])).toThrow()
  })

  it('returns an empty legend for an empty rule list', () => {
    expect(collectLegend([])).toEqual([])
  })
})

describe('createRuleContext / repairing / fatal (pre-existing behaviour, unchanged)', () => {
  it('records no issue when repairing is a no-op', () => {
    const ctx = createRuleContext()
    const out = repairing(ctx, 'TRIM', 'field', 'trimmed', 'abc', 'abc')
    expect(out).toBe('abc')
    expect(ctx.issues).toEqual([])
  })

  it('records a REPAIR issue with before/after when a value changes', () => {
    const ctx = createRuleContext()
    repairing(ctx, 'TRIM', 'field', 'trimmed', ' abc ', 'abc')
    expect(ctx.issues).toEqual([
      { code: 'TRIM', severity: 'REPAIR', message: 'trimmed', field: 'field', before: ' abc ', after: 'abc' },
    ])
  })

  it('records a FATAL issue and returns null', () => {
    const ctx = createRuleContext()
    const out = fatal(ctx, 'BLANK', 'field', 'blank', 'x')
    expect(out).toBeNull()
    expect(ctx.issues).toEqual([{ code: 'BLANK', severity: 'FATAL', message: 'blank', field: 'field', before: 'x' }])
  })
})
