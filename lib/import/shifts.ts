import type { Profession } from '@prisma/client'
import { addDays, durationMinutes, resolveShiftWindow } from '@/lib/domain/time'
import { parseProfession } from '@/lib/domain/profession'
import { splitCsv } from './csv'
import type { Issue } from './issues'
import { createFieldRule, createRuleContext, fatal, repairing, type RuleContext } from './registry'

const MAX_SHIFT_MINUTES = 720 // 12h — see §5.3

export interface ShiftRecord {
  externalId: number
  startsAt: Date
  endsAt: Date
  requirements: Record<Profession, number>
}

export interface ShiftRow {
  rowNumber: number
  raw: string
  record: ShiftRecord | null
  issues: Issue[]
}

const ISO   = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/  // dd/mm/yyyy — see §2.2
const DASH  = /^(\d{1,2})-(\d{1,2})-(\d{4})$/    // mm-dd-yyyy — see §2.2
const TIME  = /^(\d{1,2}):(\d{2})(\+1)?$/

/** True only if the y-m-d triple is a real calendar date. */
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * `field`/`describe` are deliberately field-agnostic ('staff_id / shift_id',
 * 'Id is not a whole number.') rather than shift-specific — same reasoning
 * as `makeTimeRule` below for `TIME_WHITESPACE`/`MISSING_TIME`/
 * `BAD_TIME_FORMAT`. `staff.ts`'s own `idRule` emits the SAME `INVALID_ID`
 * code; `collectLegend`/`mergeLegends` throw on a code registered twice
 * with conflicting text (Finding 1), so both pipelines must agree here even
 * though each pipeline's per-row `Issue.message`/`field` below stays
 * specific ("Shift id is not a whole number.", field: 'shift_id').
 */
const idRule = createFieldRule<string, number>({
  emits: [
    { code: 'INVALID_ID', field: 'staff_id / shift_id', severity: 'FATAL', describe: 'Id is not a whole number.' },
  ],
  run(cell, ctx) {
    const trimmed = cell.trim()
    if (!/^\d+$/.test(trimmed)) {
      return fatal(ctx, 'INVALID_ID', 'shift_id', 'Shift id is not a whole number.', cell)
    }
    return Number(trimmed)
  },
})

/**
 * Decodes the three date shapes present in the export. The slash/dash readings
 * are not guesses: across the corpus the slash form's first field reaches 30 and
 * the dash form's second field reaches 27, and both readings agree with the
 * monotonic shift_id ordering. See §2.2.
 */
const dateRule = createFieldRule<string, string>({
  emits: [
    { code: 'DATE_WHITESPACE', field: 'date', severity: 'REPAIR',
      describe: 'Trimmed surrounding whitespace from the date cell.' },
    { code: 'MISSING_DATE', field: 'date', severity: 'FATAL', describe: 'Date is empty.' },
    { code: 'DATE_FORMAT', field: 'date', severity: 'REPAIR',
      describe: 'Converted a dd/mm/yyyy slash date or mm-dd-yyyy dash date into ISO format.' },
    { code: 'AMBIGUOUS_DATE', field: 'date', severity: 'FATAL',
      describe: 'Both non-year fields exceed 12, so neither can be the month and the date cannot be resolved.' },
    { code: 'IMPOSSIBLE_DATE', field: 'date', severity: 'FATAL',
      describe: 'The calendar date does not exist (e.g. 30 February).' },
    { code: 'UNPARSEABLE_DATE', field: 'date', severity: 'FATAL',
      describe: 'Date is not in any recognised format (ISO, dd/mm/yyyy, or mm-dd-yyyy).' },
  ],
  run(cell, ctx) {
    const trimmed = cell.trim()
    // Explicit whitespace check, independent of whichever branch runs below:
    // a cell whose ONLY defect is surrounding whitespace (e.g. an already-ISO
    // date " 2026-08-18 ") must never vanish from the audit trail just
    // because the ISO branch never itself calls `repairing`. Mirrors
    // `staff.ts`'s `NAME_WHITESPACE`. `repairing` no-ops when cell === trimmed.
    repairing(ctx, 'DATE_WHITESPACE', 'date', 'Trimmed surrounding whitespace from the date.', cell, trimmed)
    if (trimmed === '') return fatal(ctx, 'MISSING_DATE', 'date', 'Date is empty.', cell)

    let y: number, m: number, d: number, code: string | null

    const iso = ISO.exec(trimmed)
    const slash = SLASH.exec(trimmed)
    const dash = DASH.exec(trimmed)

    if (iso) {
      ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      code = null
    } else if (slash) {
      ;[d, m, y] = [Number(slash[1]), Number(slash[2]), Number(slash[3])]
      if (d > 12 && m > 12) {
        return fatal(ctx, 'AMBIGUOUS_DATE', 'date',
          'Neither field can be a month, so the date cannot be resolved.', cell)
      }
      code = 'DATE_FORMAT'
    } else if (dash) {
      ;[m, d, y] = [Number(dash[1]), Number(dash[2]), Number(dash[3])]
      if (d > 12 && m > 12) {
        return fatal(ctx, 'AMBIGUOUS_DATE', 'date',
          'Neither field can be a month, so the date cannot be resolved.', cell)
      }
      code = 'DATE_FORMAT'
    } else {
      return fatal(ctx, 'UNPARSEABLE_DATE', 'date', 'Date is not in a recognised format.', cell)
    }

    if (!isRealDate(y, m, d)) {
      return fatal(ctx, 'IMPOSSIBLE_DATE', 'date', 'That calendar date does not exist.', cell)
    }

    const isoDate = `${y}-${pad(m)}-${pad(d)}`
    if (code !== null) {
      // `before` is the raw, untrimmed cell — never `trimmed` — so that a
      // whitespace-only defect never silently vanishes from the audit trail
      // just because `repairing` no-ops on `before === after` (the trap
      // Task 5 hit).
      return repairing(ctx, 'DATE_FORMAT', 'date', 'Converted the date to ISO format.', cell, isoDate)
    }
    return isoDate
  },
})

interface ParsedTime { hh: number; mm: number; plusDay: boolean }

/**
 * One rule per time column so the per-row `Issue.field` correctly identifies
 * which column a repair/rejection came from. The static `emits` descriptors
 * for the two codes shared between the start_time and end_time instances
 * (`MISSING_TIME`, `BAD_TIME_FORMAT`, and the new `TIME_WHITESPACE`) use the
 * field-agnostic text `'start_time / end_time'` rather than the per-instance
 * `field` value: `collectLegend` dedupes by code alone (first entry wins), so
 * declaring `field` here would make the legend permanently misattribute the
 * code to whichever rule is declared first, even on rows where the real
 * defect is in the other column. Per-row issues are unaffected — they always
 * carry the correct `field` via the `run` closure below.
 */
function makeTimeRule(field: 'start_time' | 'end_time') {
  return createFieldRule<string, ParsedTime>({
    emits: [
      { code: 'TIME_WHITESPACE', field: 'start_time / end_time', severity: 'REPAIR',
        describe: 'Trimmed surrounding whitespace from the time cell.' },
      { code: 'MISSING_TIME', field: 'start_time / end_time', severity: 'FATAL', describe: 'Time is empty.' },
      { code: 'BAD_TIME_FORMAT', field: 'start_time / end_time', severity: 'FATAL',
        describe: 'Time is not in HH:MM format (optionally with a "+1" next-day suffix), or is outside 00:00-23:59.' },
    ],
    run(cell, ctx) {
      const trimmed = cell.trim()
      // Explicit whitespace check, independent of the format checks below —
      // same audit-trail reasoning as dateRule above (Finding 1).
      repairing(ctx, 'TIME_WHITESPACE', field, 'Trimmed surrounding whitespace from the time.', cell, trimmed)
      if (trimmed === '') return fatal(ctx, 'MISSING_TIME', field, `${field} is empty.`, cell)

      const m = TIME.exec(trimmed)
      if (!m) return fatal(ctx, 'BAD_TIME_FORMAT', field, 'Time is not in HH:MM format.', cell)

      const hh = Number(m[1])
      const mm = Number(m[2])
      if (hh > 23 || mm > 59) {
        return fatal(ctx, 'BAD_TIME_FORMAT', field, 'Time is outside 00:00-23:59.', cell)
      }
      return { hh, mm, plusDay: m[3] === '+1' }
    },
  })
}

const startTimeRule = makeTimeRule('start_time')
const endTimeRule = makeTimeRule('end_time')

const REQUIREMENT_PAIR = /^([a-z_]+)=(\d+)$/

const requirementsRule = createFieldRule<string, Record<Profession, number>>({
  emits: [
    { code: 'REQUIREMENTS_WHITESPACE', field: 'requirements', severity: 'REPAIR',
      describe: 'Trimmed surrounding whitespace from the requirements cell.' },
    { code: 'UNPARSEABLE_REQUIREMENTS', field: 'requirements', severity: 'FATAL',
      describe: 'Requirements are empty or not in "role=count;role=count" form; free text is never guessed.' },
    { code: 'UNKNOWN_REQUIREMENT_KEY', field: 'requirements', severity: 'FATAL',
      describe: 'A requirement key does not match a profession this clinic schedules.' },
    { code: 'REQUIREMENT_DEFAULTED', field: 'requirements', severity: 'REPAIR',
      describe: 'A role was omitted from the requirements; its count was defaulted to 0.' },
    { code: 'ZERO_HEADCOUNT', field: 'requirements', severity: 'FATAL',
      describe: 'All requirement counts are zero, so the row does not describe a real shift.' },
  ],
  run(cell, ctx) {
    const trimmed = cell.trim()
    // Same gap as dateRule/makeTimeRule (Finding 1): a requirements cell whose
    // ONLY defect is surrounding whitespace must not vanish from the audit
    // trail just because every downstream branch operates on `trimmed`.
    repairing(ctx, 'REQUIREMENTS_WHITESPACE', 'requirements',
      'Trimmed surrounding whitespace from the requirements.', cell, trimmed)
    const out: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
    const seen = new Set<Profession>()

    if (trimmed === '') {
      return fatal(ctx, 'UNPARSEABLE_REQUIREMENTS', 'requirements', 'Requirements are empty.', cell)
    }

    for (const part of trimmed.split(';')) {
      const m = REQUIREMENT_PAIR.exec(part.trim().toLowerCase())
      if (!m) {
        return fatal(ctx, 'UNPARSEABLE_REQUIREMENTS', 'requirements',
          'Requirements are not in "role=count" form; refusing to guess the intent.', cell)
      }
      const profession = parseProfession(m[1]!)
      if (profession === null) {
        return fatal(ctx, 'UNKNOWN_REQUIREMENT_KEY', 'requirements',
          `"${m[1]}" is not a profession this clinic schedules.`, cell)
      }
      out[profession] = Number(m[2])
      seen.add(profession)
    }

    const missing = (['DOCTOR', 'NURSE', 'RECEPTIONIST'] as Profession[]).filter((p) => !seen.has(p))
    if (missing.length > 0) {
      // `before` is the raw, untrimmed cell — never `trimmed` — for the same
      // audit-trail reason as in dateRule above.
      repairing(ctx, 'REQUIREMENT_DEFAULTED', 'requirements',
        `No count given for ${missing.join(', ').toLowerCase()}; defaulted to 0.`,
        cell, JSON.stringify(out))
    }

    if (out.DOCTOR + out.NURSE + out.RECEPTIONIST === 0) {
      return fatal(ctx, 'ZERO_HEADCOUNT', 'requirements',
        'Shift requires nobody, so it is not a shift.', cell)
    }
    return out
  },
})

/**
 * Amendment A consumer: one rule declaration feeds the pipeline below, and
 * (via collectLegend) the Import Report legend in Task 19. Note that
 * `collectLegend(SHIFT_RULES)` alone does not cover every code
 * `parseShiftRows` can emit — `BAD_ARITY` is covered by
 * `lib/import/registry.ts`'s `STRUCTURAL_RULES`, and `OVERNIGHT_ROLLOVER` /
 * `EXPLICIT_NEXT_DAY` / `DURATION_TOO_LONG` (pushed directly below, outside
 * any single-cell rule) are covered by its `SHIFT_WINDOW_RULES`.
 */
export const SHIFT_RULES = [idRule, dateRule, startTimeRule, endTimeRule, requirementsRule]

export function parseShiftRows(text: string): ShiftRow[] {
  return splitCsv(text).rows.map(({ rowNumber, raw, cells }) => {
    const ctx: RuleContext & { issues: Issue[] } = createRuleContext()

    if (cells.length !== 5) {
      ctx.push({
        code: 'BAD_ARITY', severity: 'FATAL',
        message: `Expected 5 columns, found ${cells.length}.`, before: raw,
      })
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const externalId = idRule.run(cells[0]!, ctx)
    const date  = dateRule.run(cells[1]!, ctx)
    const start = startTimeRule.run(cells[2]!, ctx)
    const end   = endTimeRule.run(cells[3]!, ctx)
    const requirements = requirementsRule.run(cells[4]!, ctx)

    if (externalId === null || date === null || start === null || end === null || requirements === null) {
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const startTime = `${pad(start.hh)}:${pad(start.mm)}`
    const endTime = `${pad(end.hh)}:${pad(end.mm)}`

    // The rollover rule itself lives in resolveShiftWindow so the importer and
    // the shift API cannot disagree about what "22:00-06:00" means. Here we only
    // LOG which repair happened; the single duration cap below then catches the
    // 18h, 24h and 26h rows alike. §5.3
    const window = resolveShiftWindow(date, startTime, endTime, end.plusDay)

    if (window.rolledOverToNextDay) {
      const after = `${addDays(date, 1)} ${endTime}`
      // `before` is the raw, untrimmed end_time cell — never `.trim()` — for
      // the same audit-trail reason as in dateRule above.
      if (end.plusDay) {
        repairing(ctx, 'EXPLICIT_NEXT_DAY', 'end_time',
          'End time carries "+1"; moved to the next day.', cells[3]!, after)
      } else {
        repairing(ctx, 'OVERNIGHT_ROLLOVER', 'end_time',
          'End is at or before the start, so the shift runs overnight; moved the end to the next day.',
          cells[3]!, after)
      }
    }

    const { startsAt, endsAt } = window
    const mins = durationMinutes({ startsAt, endsAt })

    if (mins <= 0 || mins > MAX_SHIFT_MINUTES) {
      fatal(ctx, 'DURATION_TOO_LONG', 'end_time',
        `Shift is ${(mins / 60).toFixed(1)}h; the maximum is ${MAX_SHIFT_MINUTES / 60}h.`, raw)
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    return {
      rowNumber, raw,
      record: { externalId, startsAt, endsAt, requirements },
      issues: ctx.issues,
    }
  })
}
