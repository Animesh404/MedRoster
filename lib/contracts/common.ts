import { z } from 'zod'

export const PROFESSION = z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST'])

export const requirementsSchema = z.object({
  DOCTOR: z.number().int().min(0).max(50),
  NURSE: z.number().int().min(0).max(50),
  RECEPTIONIST: z.number().int().min(0).max(50),
}).refine((r) => r.DOCTOR + r.NURSE + r.RECEPTIONIST > 0, {
  message: 'A shift must require at least one person.',
})

export const pageQuerySchema = z.object({
  cursor: z.string().nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
})

/** Client-generated id used to suppress a caller's own realtime echo (§7.1). */
export const mutationIdSchema = z.string().min(8).max(64).optional()

export type Requirements = z.infer<typeof requirementsSchema>
