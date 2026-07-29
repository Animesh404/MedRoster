import Link from 'next/link'

/**
 * Forward-only pagination for a keyset-paginated list (`lib/db/paginate.ts`
 * only ever returns a `nextCursor`, never a "previous" one — going back
 * would need the caller to remember every cursor it's already visited).
 * Good enough for a "paginated run history" / "paginated row table" without
 * that extra bookkeeping: "Next" advances, "Start over" always gets back to
 * page one.
 */
export function PaginationLinks({
  basePath,
  searchParams,
  nextCursor,
  onFirstPage,
}: {
  basePath: string
  searchParams: Record<string, string | undefined>
  nextCursor: string | null
  onFirstPage: boolean
}) {
  if (!nextCursor && onFirstPage) return null

  function hrefWith(cursor: string | undefined) {
    const usp = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== 'cursor') usp.set(k, v)
    }
    if (cursor) usp.set('cursor', cursor)
    const qs = usp.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  return (
    <div className="flex items-center justify-between gap-2 pt-2 text-sm">
      {!onFirstPage ? (
        <Link href={hrefWith(undefined)} className="text-brand-deep underline-offset-2 hover:underline dark:text-brand-mid">
          Start over
        </Link>
      ) : <span />}
      {nextCursor ? (
        <Link href={hrefWith(nextCursor)} className="font-medium text-brand-deep underline-offset-2 hover:underline dark:text-brand-mid">
          Next →
        </Link>
      ) : <span className="text-muted-foreground">End of list</span>}
    </div>
  )
}
