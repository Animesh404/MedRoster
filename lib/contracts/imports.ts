import { z } from 'zod'

export const importKindSchema = z.enum(['STAFF', 'SHIFT'])

/** Postgres `text` columns cannot store a NUL byte at all (error 22021)
 *  regardless of which text field it lands in — this isn't specific to file
 *  content. `ImportRun.filename` is exactly as vulnerable as the CSV body:
 *  a filename of `evil\x00.csv` reaches `ImportRun.create` and 500s the same
 *  way an uncaught NUL in the row text would.
 *
 *  Every text field the import route derives from user input is checked
 *  here, in one place: the caller passes them all into a single call as one
 *  object, so the next person adding a third text field to the upload path
 *  has one obvious spot to extend rather than an easy-to-miss second
 *  `.includes('\0')` check to remember to bolt on elsewhere.
 *
 *  Returns the name of the first offending field, or `null` if all are clean.
 */
export function findNulByteField(fields: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (value.includes('\0')) return name
  }
  return null
}

/** `ImportRun.filename` is an unbounded `text` column rendered directly in
 *  the Import Report UI — bound it so a pathologically long filename can't
 *  bloat storage or the report view. Long, not malformed, so truncation
 *  (rather than rejection) is the right response.
 */
const MAX_FILENAME_LENGTH = 255

export function normalizeFilename(filename: string): string {
  return filename.length > MAX_FILENAME_LENGTH ? filename.slice(0, MAX_FILENAME_LENGTH) : filename
}

export const importStatsSchema = z.object({
  accepted: z.number().int(),
  merged: z.number().int(),
  rejected: z.number().int(),
  total: z.number().int(),
})

/** ACCEPTED/REPAIRED split out, unlike `importStatsSchema` — see
 *  `getExactOutcomeCounts` (lib/import/report.ts) for why the Import Report
 *  needs this shape instead. */
export const exactOutcomeCountsSchema = z.object({
  accepted: z.number().int(),
  repaired: z.number().int(),
  merged: z.number().int(),
  rejected: z.number().int(),
  total: z.number().int(),
})

const importIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['REPAIR', 'FATAL']),
  message: z.string(),
  field: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
})

export const importRowSchema = z.object({
  id: z.number().int(),
  rowNumber: z.number().int(),
  rawRow: z.string(),
  outcome: z.enum(['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED']),
  issues: z.array(importIssueSchema),
})

export type ImportRowView = z.infer<typeof importRowSchema>
