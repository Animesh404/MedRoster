import { isoWeekOf } from '@/lib/domain/time'

/** Subscribers listen per week, so a claim on Aug 12 never wakes an Aug 20 viewer. §7.1 */
export const weekTopic = (d: Date): string => `week:${isoWeekOf(d)}`

export const EVENT_TYPES = [
  'shift.created', 'shift.edited', 'shift.deleted',
  'shift.claimed', 'shift.unclaimed', 'shift.claims_dropped',
] as const

export type EventType = (typeof EVENT_TYPES)[number]
