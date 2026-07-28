import type { Profession } from '@prisma/client'

/** Every spelling seen in the clinic's exports, plus the canonical forms. §5.2 */
const ALIASES: Record<string, Profession> = {
  nurse: 'NURSE', nurses: 'NURSE', rn: 'NURSE', 'registered nurse': 'NURSE',
  doctor: 'DOCTOR', doctors: 'DOCTOR', md: 'DOCTOR', physician: 'DOCTOR',
  receptionist: 'RECEPTIONIST', receptionists: 'RECEPTIONIST',
  reception: 'RECEPTIONIST', recep: 'RECEPTIONIST',
}

/** Lower-cases, collapses whitespace and strips a trailing period ("recep." -> "recep"). */
function canonicalise(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')
}

export function parseProfession(raw: string): Profession | null {
  return ALIASES[canonicalise(raw)] ?? null
}

export const PROFESSION_LABELS: Record<Profession, string> = {
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Receptionist',
}

export const PROFESSIONS: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']
