export function encodeCursor(id: number): string {
  return Buffer.from(`id:${id}`, 'utf8').toString('base64url')
}

const MAX_PG_INT = 2_147_483_647

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const m = /^id:(\d+)$/.exec(raw)
    if (!m) return null
    // The regex alone doesn't bound magnitude — an arbitrarily long digit
    // string (e.g. a forged `id:99999999999999999999`) decodes to a number
    // Prisma's query engine rejects with a validation error (500). Bound it
    // to what an `Int` id could ever legitimately be; anything else is
    // indistinguishable from a garbage cursor, which already degrades to a
    // fresh first page.
    const n = Number(m[1])
    return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PG_INT ? n : null
  } catch {
    return null
  }
}

interface FindManyArgs {
  take: number
  skip?: number
  cursor?: { id: number }
  orderBy: { id: 'asc' }
}

export interface PaginateArgs<T> {
  findMany: (args: FindManyArgs) => Promise<T[]>
  limit: number
  cursor: string | null
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Keyset pagination (§6.4). Anchoring on the last row's id rather than an
 * offset means rows inserted or deleted earlier in the list cannot make a
 * later page skip or repeat entries — which matters here because shifts and
 * claims change under a scrolling list in real time.
 */
export async function paginate<T extends { id: number }>(
  args: PaginateArgs<T>,
): Promise<Page<T>> {
  const limit = Math.min(Math.max(args.limit, 1), 100)
  const after = args.cursor ? decodeCursor(args.cursor) : null

  const rows = await args.findMany({
    take: limit + 1, // one extra row tells us whether another page exists
    orderBy: { id: 'asc' },
    ...(after !== null ? { cursor: { id: after }, skip: 1 } : {}),
  })

  const items = rows.slice(0, limit)
  const nextCursor = rows.length > limit && items.length > 0
    ? encodeCursor(items[items.length - 1]!.id)
    : null

  return { items, nextCursor }
}
