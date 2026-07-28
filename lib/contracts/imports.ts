import { z } from 'zod'

export const importKindSchema = z.enum(['STAFF', 'SHIFT'])

export const importStatsSchema = z.object({
  accepted: z.number().int(),
  merged: z.number().int(),
  rejected: z.number().int(),
  total: z.number().int(),
})

export const importIssueSchema = z.object({
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

export type ImportKind = z.infer<typeof importKindSchema>
export type ImportRowView = z.infer<typeof importRowSchema>
