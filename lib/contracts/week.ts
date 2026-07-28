import { z } from 'zod'
import type { Profession } from '@prisma/client'

const PROFESSION_ORDER: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']

export interface WeekStaff { id: number; name: string; profession: Profession }

export interface WeekShift {
  id: number
  version: number
  startsAt: string
  endsAt: string
  requirements: Record<Profession, number>
  claimantIds: number[]
}

export interface WeekView {
  isoWeek: string
  staff: WeekStaff[]
  shifts: WeekShift[]
}

/**
 * Wire format (§6.2). Staff and profession names appear once per response
 * instead of once per claim, and shifts become positional tuples.
 *
 *   s: [[id, name, professionIndex], …]
 *   h: [[id, version, startsAt, endsAt, [dr, nu, re], [staffIndex, …]], …]
 *
 * The payload is not readable raw in devtools, which is why the encoder and
 * decoder live together here and are round-trip tested. No other endpoint uses
 * this encoding.
 */
export interface CompressedWeek {
  w: string
  p: Profession[]
  s: [number, string, number][]
  h: [number, number, string, string, [number, number, number], number[]][]
}

export function encodeWeek(view: WeekView): CompressedWeek {
  const staffIndex = new Map<number, number>()
  const s = view.staff.map((member, i) => {
    staffIndex.set(member.id, i)
    return [member.id, member.name, PROFESSION_ORDER.indexOf(member.profession)] as
      [number, string, number]
  })

  const h = view.shifts.map((shift) => [
    shift.id,
    shift.version,
    shift.startsAt,
    shift.endsAt,
    [shift.requirements.DOCTOR, shift.requirements.NURSE, shift.requirements.RECEPTIONIST] as
      [number, number, number],
    shift.claimantIds.map((id) => staffIndex.get(id) ?? -1).filter((i) => i >= 0),
  ] as CompressedWeek['h'][number])

  return { w: view.isoWeek, p: PROFESSION_ORDER, s, h }
}

export function decodeWeek(c: CompressedWeek): WeekView {
  const staff: WeekStaff[] = c.s.map(([id, name, p]) => ({
    id, name, profession: c.p[p]!,
  }))

  const shifts: WeekShift[] = c.h.map(([id, version, startsAt, endsAt, req, claimants]) => ({
    id, version, startsAt, endsAt,
    requirements: { DOCTOR: req[0], NURSE: req[1], RECEPTIONIST: req[2] },
    claimantIds: claimants.map((i) => staff[i]!.id),
  }))

  return { isoWeek: c.w, staff, shifts }
}

export const isoWeekParamSchema = z.string().regex(/^\d{4}-W\d{2}$/, 'Use YYYY-Www.')

const professionSchema: z.ZodType<Profession> = z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST'])

/**
 * Enforces, not merely declares, the wire shape `GET /api/weeks/:isoWeek`
 * hands back — the same discipline `shiftDetailSchema` applies to the shift
 * route (§6.2/MIN-2). Parsing `encodeWeek`'s output through this before it's
 * serialised means a future change to the encoder can't silently drift the
 * response shape out from under the decoder without a type error here.
 */
export const compressedWeekSchema: z.ZodType<CompressedWeek> = z.object({
  w: z.string(),
  p: z.array(professionSchema),
  s: z.array(z.tuple([z.number(), z.string(), z.number()])),
  h: z.array(z.tuple([
    z.number(), z.number(), z.string(), z.string(),
    z.tuple([z.number(), z.number(), z.number()]),
    z.array(z.number()),
  ])),
})
