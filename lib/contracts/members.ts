import { z } from 'zod'

/**
 * Role and profession are chosen by the inviting MANAGER and are never supplied
 * by the invitee — that is what keeps the RBAC model airtight under an
 * invite-only policy (spec §1). A STAFF member must carry a profession, since
 * every claim rule is keyed on it; a MANAGER must not.
 */
export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  name: z.string().trim().min(1, 'Enter the person’s name.'),
  role: z.enum(['MANAGER', 'STAFF']),
  profession: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST']).nullable(),
}).refine(
  (v) => (v.role === 'STAFF' ? v.profession !== null : v.profession === null),
  { message: 'Staff need a profession; managers must not have one.', path: ['profession'] },
)

