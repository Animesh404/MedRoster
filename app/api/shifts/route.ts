import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { createShiftSchema } from '@/lib/contracts/shifts'
import { createAppError } from '@/lib/domain/errors'
import { PROFESSIONS } from '@/lib/domain/profession'
import { resolveShiftWindow } from '@/lib/domain/time'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from '@/lib/rules/assign'

export const GET = withAuth('shift:read', async (req) => {
  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.shift.findMany({
      ...args,
      include: { requirements: true, _count: { select: { claims: true } } },
    }),
  })

  return NextResponse.json(page)
})

/** Expands a recurrence rule into the concrete dates it covers (§9). */
function occurrenceDates(from: string, weekdays: number[], until: string): string[] {
  const out: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number)
  const cursor = new Date(Date.UTC(fy!, fm! - 1, fd!))
  const end = new Date(`${until}T00:00:00Z`)
  const wanted = new Set(weekdays)

  while (cursor <= end && out.length < 366) {
    if (wanted.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

export const POST = withAuth('shift:create', async (req) => {
  const parsed = createShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const { date, startTime, endTime, requirements, recurrence, mutationId } = parsed.data

  const dates = recurrence
    ? occurrenceDates(date, recurrence.weekdays, recurrence.untilDate)
    : [date]

  if (dates.length === 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That recurrence covers no dates.'))
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
    for (const d of dates) {
      const { startsAt, endsAt } = resolveShiftWindow(d, startTime, endTime)

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
