import { describe, expect, it } from 'vitest'
import { createIssue, deriveOutcome } from '@/lib/import/issues'

const repair = () => createIssue('WHITESPACE', 'REPAIR', 'Trimmed whitespace')
const fatal  = () => createIssue('BLANK_NAME', 'FATAL', 'Name is empty')

describe('deriveOutcome', () => {
  it('is ACCEPTED when nothing happened', () => {
    expect(deriveOutcome([], false)).toBe('ACCEPTED')
  })

  it('is REPAIRED when only repairs happened', () => {
    expect(deriveOutcome([repair()], false)).toBe('REPAIRED')
  })

  it('is REJECTED when any issue is fatal, even alongside repairs', () => {
    expect(deriveOutcome([repair(), fatal()], false)).toBe('REJECTED')
  })

  it('lets a fatal issue beat a merge', () => {
    expect(deriveOutcome([fatal()], true)).toBe('REJECTED')
  })

  it('is MERGED when the row folded into another and nothing was fatal', () => {
    expect(deriveOutcome([repair()], true)).toBe('MERGED')
  })
})
