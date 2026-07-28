import type { Profession } from '@prisma/client'
import { parseProfession, PROFESSION_LABELS } from '@/lib/domain/profession'
import { splitCsv } from './csv'
import type { Issue } from './issues'
import { createFieldRule, createRuleContext, fatal, repairing } from './registry'

export interface StaffRecord {
  externalId: number
  name: string
  email: string
  profession: Profession
}

export interface StaffRow {
  rowNumber: number
  raw: string
  record: StaffRecord | null
  issues: Issue[]
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const idRule = createFieldRule<string, number>({
  emits: [
    { code: 'INVALID_ID', field: 'staff_id', severity: 'FATAL', describe: 'Staff id is not a whole number.' },
  ],
  run(cell, ctx) {
    const trimmed = cell.trim()
    if (!/^\d+$/.test(trimmed)) {
      return fatal(ctx, 'INVALID_ID', 'staff_id', 'Staff id is not a whole number.', cell)
    }
    return Number(trimmed)
  },
})

export const nameRule = createFieldRule<string, string>({
  emits: [
    { code: 'BLANK_NAME', field: 'full_name', severity: 'FATAL',
      describe: 'Name is empty; the row cannot create a staff member.' },
    { code: 'NAME_WHITESPACE', field: 'full_name', severity: 'REPAIR',
      describe: 'Trimmed surrounding whitespace from the name. Casing is never altered.' },
  ],
  run(cell, ctx) {
    // Whitespace only. Casing is never touched — "ALI", "McDonald", "van der Berg". §5.4
    const cleaned = cell.trim().replace(/\s+/g, ' ')
    if (cleaned === '') {
      return fatal(ctx, 'BLANK_NAME', 'full_name', 'Name is empty; cannot create a staff member.', cell)
    }
    return repairing(ctx, 'NAME_WHITESPACE', 'full_name', 'Trimmed surrounding whitespace.', cell, cleaned)
  },
})

export const professionRule = createFieldRule<string, Profession>({
  emits: [
    { code: 'UNKNOWN_PROFESSION', field: 'role', severity: 'FATAL',
      describe: 'Role does not match any profession this clinic schedules.' },
    { code: 'ROLE_ALIAS', field: 'role', severity: 'REPAIR',
      describe: 'Normalised a role alias or casing onto the enum value.' },
  ],
  run(cell, ctx) {
    const parsed = parseProfession(cell)
    if (parsed === null) {
      return fatal(ctx, 'UNKNOWN_PROFESSION', 'role',
        `"${cell.trim()}" is not a profession this clinic schedules.`, cell)
    }
    // Compare against the human-readable label ("Doctor"), not the raw Prisma
    // enum ("DOCTOR") — otherwise every already-correct role would be flagged
    // as a repair purely because the enum constant is upper-cased.
    repairing(ctx, 'ROLE_ALIAS', 'role', 'Normalised the role spelling.', cell.trim(), PROFESSION_LABELS[parsed])
    return parsed
  },
})

export const emailRule = createFieldRule<string, string>({
  emits: [
    { code: 'BLANK_EMAIL', field: 'email', severity: 'FATAL',
      describe: 'Email is empty; it is the login identity so the row cannot be imported.' },
    { code: 'EMAIL_AT_LITERAL', field: 'email', severity: 'REPAIR',
      describe: 'Replaced a literal "(at)" with "@".' },
    { code: 'EMAIL_CASE', field: 'email', severity: 'REPAIR',
      describe: 'Lower-cased the address so duplicates are detectable.' },
    { code: 'INVALID_EMAIL', field: 'email', severity: 'FATAL',
      describe: 'Not a valid email address, even after repair.' },
  ],
  run(cell, ctx) {
    const trimmed = cell.trim()
    if (trimmed === '') {
      return fatal(ctx, 'BLANK_EMAIL', 'email',
        'Email is empty; it is the login identity so the row cannot be imported.', cell)
    }

    let value = trimmed
    if (value.includes('(at)')) {
      value = repairing(ctx, 'EMAIL_AT_LITERAL', 'email',
        'Replaced the literal "(at)" with "@".', value, value.replace('(at)', '@'))
    }
    value = repairing(ctx, 'EMAIL_CASE', 'email',
      'Lower-cased the address so duplicates are detectable.', value, value.toLowerCase())

    if (!EMAIL_SHAPE.test(value)) {
      return fatal(ctx, 'INVALID_EMAIL', 'email', 'Not a valid email address.', cell)
    }
    return value
  },
})

/** Amendment A consumer: one rule declaration feeds the pipeline below, and (via
 * collectLegend) the Import Report legend in Task 19. */
export const STAFF_RULES = [idRule, nameRule, professionRule, emailRule]

export function parseStaffRows(text: string): StaffRow[] {
  return splitCsv(text).rows.map(({ rowNumber, raw, cells }) => {
    const ctx = createRuleContext()

    if (cells.length !== 4) {
      ctx.push({
        code: 'BAD_ARITY', severity: 'FATAL',
        message: `Expected 4 columns, found ${cells.length}.`, before: raw,
      })
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const externalId = idRule.run(cells[0]!, ctx)
    const name       = nameRule.run(cells[1]!, ctx)
    const profession = professionRule.run(cells[2]!, ctx)
    const email      = emailRule.run(cells[3]!, ctx)

    const record =
      externalId !== null && name !== null && profession !== null && email !== null
        ? { externalId, name, email, profession }
        : null

    return { rowNumber, raw, record, issues: ctx.issues }
  })
}
