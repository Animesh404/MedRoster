/** A Supabase auth user, narrowed to the fields this app reads. */
export interface PagedAuthUser {
  id: string
  email?: string
  confirmed_at?: string
}

/** The shape of `supabase.auth.admin.listUsers`, narrowed to what paging needs. */
export type PagedListUsers = (
  params?: { page?: number; perPage?: number },
) => Promise<{ data: { users: PagedAuthUser[] }; error: unknown }>

export interface ListAllOptions {
  /** Users per request. Supabase caps this well below 1000 in practice. */
  perPage?: number
  /** Runaway guard — see the throw below. */
  maxPages?: number
}

const DEFAULT_PER_PAGE = 200
const DEFAULT_MAX_PAGES = 50

/**
 * Every Supabase auth user, paged.
 *
 * Replaces a `listUsers({ perPage: 1000 })` call that treated one page as the
 * whole directory. Past 1000 users that silently dropped the remainder, and
 * because the caller joins this against the roster to derive account status,
 * a dropped user rendered as "No account" — a confident wrong answer rather
 * than an error, which is the worst failure shape available.
 *
 * **Termination is on a short page, not on `nextPage`/`lastPage`.** Those
 * fields exist but have moved around between Supabase releases, and trusting
 * one that quietly disappears reintroduces exactly the silent truncation this
 * function exists to remove. A short page is a property of the data.
 *
 * **A partial result is never returned.** If any page errors, the caller gets
 * the error and an empty list, so it renders a failure rather than a plausible
 * roster with people missing from it.
 */
export async function listAllAuthUsers(
  listUsers: PagedListUsers,
  opts: ListAllOptions = {},
): Promise<{ users: PagedAuthUser[]; error: unknown }> {
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES

  const users: PagedAuthUser[] = []

  for (let page = 1; page <= maxPages; page++) {
    const { data, error } = await listUsers({ page, perPage })
    if (error) return { users: [], error }

    const batch = data?.users ?? []
    users.push(...batch)

    // Short page ⇒ that was the last one. An exact multiple of `perPage` has
    // no short page, so it costs one extra empty request to learn it is done —
    // cheap, and the alternative is an off-by-one that drops the final page.
    if (batch.length < perPage) return { users, error: null }
  }

  // Reached only if every page came back full. Either the directory is larger
  // than this app is designed for, or the service is misbehaving. Failing is
  // right: an unbounded walk would hang the request instead of ending it, and
  // returning what we have would be the silent truncation all over again.
  return {
    users: [],
    error: new Error(
      `Refusing to page further: too many Supabase users (over ${maxPages * perPage}). ` +
        'Raise maxPages deliberately, or move this lookup to a keyed query.',
    ),
  }
}
