import type { Profession } from '@prisma/client'
import type { CoverageStatus } from '@/lib/coverage'

/**
 * The single definition of how a staffing status looks and reads.
 *
 * Every badge, meter and legend pulls from here, so the week grid and the shift
 * detail page cannot drift apart. Each status carries a distinct glyph AND a
 * distinct label as well as a hue — status has to survive greyscale printing and
 * colour-blind readers, and a rota gets printed and pinned to a wall.
 */
export const STATUS_STYLES: Record<CoverageStatus, {
  label: string
  glyph: string
  dot: string
  chip: string
  /** Ring colour for the day-column header when this is the day's worst status. */
  spine: string
}> = {
  FULL: {
    label: 'Fully staffed',
    glyph: '●',
    dot: 'bg-emerald-600',
    chip: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
    spine: 'bg-emerald-500/60',
  },
  PARTIAL: {
    label: 'Partly staffed',
    glyph: '◐',
    dot: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-900',
    spine: 'bg-amber-500/70',
  },
  EMPTY: {
    label: 'Nobody assigned',
    glyph: '○',
    dot: 'bg-rose-600',
    chip: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900',
    spine: 'bg-rose-500/70',
  },
}

/**
 * Single-letter profession marks used by the slot meter.
 *
 * Deliberately not the first letter of each label — D/N/R happen to be unique
 * here, but pinning them explicitly means adding a profession later cannot
 * silently collide (e.g. a future "Radiographer" would clash with Receptionist).
 */
export const PROFESSION_MARKS: Record<Profession, string> = {
  DOCTOR: 'D',
  NURSE: 'N',
  RECEPTIONIST: 'R',
}

/** Order professions appear in every meter, so scanning down a column is stable. */
export const METER_ORDER: Profession[] = ['NURSE', 'DOCTOR', 'RECEPTIONIST']

export interface MeterSegment {
  profession: Profession
  mark: string
  filled: number
  required: number
}

/**
 * Builds the slot meter — this product's signature element.
 *
 * A shift's staffing is rendered as literal slots rather than a percentage or a
 * status word: filled slots for people who hold the shift, hollow slots for the
 * gap. The shape of the gap IS the data, which is what a manager is actually
 * scanning for.
 *
 *   N ●●○   D ●   R ○      needs one more nurse and a receptionist
 *   N ●●●   D ●   R ●      covered
 *   N ○○○   D ○   R ○      nobody
 *
 * Professions a shift does not require are omitted entirely — an empty rail for
 * a role the shift never needed reads as a gap when it is not one.
 */
export function buildMeter(
  requirements: Record<Profession, number>,
  claims: Record<Profession, number>,
): MeterSegment[] {
  return METER_ORDER.filter((p) => requirements[p] > 0).map((profession) => ({
    profession,
    mark: PROFESSION_MARKS[profession],
    // Clamp so an over-staffed shift shows a full rail rather than overflowing it.
    filled: Math.min(claims[profession], requirements[profession]),
    required: requirements[profession],
  }))
}

/** Plain-text rendering of the meter, for aria-labels and non-visual contexts. */
export function meterLabel(segments: MeterSegment[]): string {
  if (segments.length === 0) return 'No staffing required'
  return segments
    .map((s) => `${s.filled} of ${s.required} ${s.profession.toLowerCase()}${s.required === 1 ? '' : 's'}`)
    .join(', ')
}
