import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { createShiftSchema } from '@/lib/contracts/shifts'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { PROFESSIONS } from '@/lib/domain/profession'
import { resolveShiftWindow, type ShiftWindow } from '@/lib/domain/time'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from '@/lib/rules/assign'

export const GET = withAuth('shift:read', async (req) => {
  const url = new URL(req.url)
  // .safeParse, not .parse (IMP-3): an ordinary bad query string (`?limit=abc`,
  // `?limit=0`, `?limit=`, `?limit=Infinity`, ...) must come back as a 400,
  // not an uncaught ZodError turning into a 500 with a stack trace.
  const parsedQuery = pageQuerySchema.safeParse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsedQuery.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsedQuery.error.issues[0]!.message))
  }
  const { cursor, limit } = parsedQuery.data

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.shift.findMany({
      ...args,
      include: { requirements: true, _count: { select: { claims: true } } },
    }),
  })

  return NextResponse.json(page)
})

const MAX_OCCURRENCES = 366

/**
 * Expands a recurrence rule into the concrete dates it covers (§9).
 *
 * The 366-row cap is a safety valve, not a feature: MIN-5 found that hitting
 * it produced no error, just a silently clipped roster (366 shifts created,
 * client told nothing). `truncated` lets the caller distinguish "here are
 * all the dates" from "there were more than we'd create in one request" so
 * it can refuse rather than guess.
 */
function occurrenceDates(
  from: string, weekdays: number[], until: string,
): { dates: string[]; truncated: boolean } {
  const out: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number)
  const cursor = new Date(Date.UTC(fy!, fm! - 1, fd!))
  const end = new Date(`${until}T00:00:00Z`)
  const wanted = new Set(weekdays)
  let truncated = false

  while (cursor <= end) {
    if (out.length >= MAX_OCCURRENCES) {
      truncated = true
      break
    }
    if (wanted.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return { dates: out, truncated }
}

/**
 * Rejects a proposed shift interval that is nonsensical or already in the
 * past — the create-side counterpart of `lib/rules/edit.ts`'s
 * `validateProposedInterval` (IMP-1). `commitShiftEdit` already refuses a
 * degenerate/past window; `POST` previously called nothing, so a typo'd
 * date silently became a real, possibly-past roster entry. This mirrors
 * that check's two rules exactly, applied per resolved window.
 */
function validateShiftWindow(window: ShiftWindow, now: Date): AppError | null {
  if (window.startsAt >= window.endsAt) {
    return createAppError('INVALID_INPUT', 'A shift must start before it ends.')
  }
  if (window.startsAt <= now) {
    return createAppError('INVALID_INPUT', 'A shift cannot be created in the past.')
  }
  return null
}

export const POST = withAuth('shift:create', async (req) => {
  const parsed = createShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const { date, startTime, endTime, requirements, recurrence, mutationId } = parsed.data

  const expansion = recurrence
    ? occurrenceDates(date, recurrence.weekdays, recurrence.untilDate)
    : { dates: [date], truncated: false }

  if (expansion.truncated) {
    return errorResponse(createAppError(
      'INVALID_INPUT',
      `That recurrence covers more than ${MAX_OCCURRENCES} dates. Narrow the range and try again.`,
    ))
  }
  if (expansion.dates.length === 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That recurrence covers no dates.'))
  }

  const now = new Date()
  const windows = expansion.dates.map((d) => ({ date: d, ...resolveShiftWindow(d, startTime, endTime) }))
  for (const window of windows) {
    const invalid = validateShiftWindow(window, now)
    if (invalid) return errorResponse(invalid)
  }

  const created = await prisma.$transaction(async (tx) => {
    const series = recurrence
      ? await tx.shiftSeries.create({
          data: {
            weekdays: recurrence.weekdays, startTime, endTime,
            untilDate: new Date(`${recurrence.untilDate}T00:00:00Z`),
            requirements,
          },
        })
      : null

    const ids: number[] = []
    for (const { startsAt, endsAt } of windows) {
      const shift = await tx.shift.create({
        data: {
          startsAt, endsAt, seriesId: series?.id ?? null,
          requirements: {
            create: PROFESSIONS.map((profession) => ({
              profession, requiredCount: requirements[profession],
            })),
          },
        },
      })
      ids.push(shift.id)

      await emitEvent(tx, {
        topic: weekTopic(startsAt), type: 'shift.created',
        payload: { shiftId: shift.id, startsAt: startsAt.toISOString() },
        ...(mutationId !== undefined ? { mutationId } : {}),
      })
    }
    return { ids, seriesId: series?.id ?? null }
  }, { ...TX_OPTIONS, timeout: 30_000 })

  return NextResponse.json(created, { status: 201 })
})
