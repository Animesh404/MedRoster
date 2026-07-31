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
  /** Users per request. */
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
 * **Termination is on an EMPTY page** — not on `nextPage`/`lastPage`, and not
 * on a short one.
 *
 * Not `nextPage`/`lastPage`: those fields exist but have moved between Supabase
 * releases, and trusting one that quietly disappears reintroduces exactly the
 * silent truncation this function exists to remove.
 *
 * Not a *short* page either, which is the subtler trap and the one an earlier
 * version of this file fell into. "Short" only means "last" if the service
 * always honours the `perPage` you asked for. If it ever caps `per_page`
 * server-side below the requested value, page 1 comes back short, the walk
 * stops on page 1, and the caller silently gets a fraction of the directory —
 * the original bug, restored, with the error path never firing. Whether such a
 * cap exists is not something this code should have to know: waiting for a
 * genuinely empty page is correct either way, and costs one extra request.
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
    if (batch.length === 0) return { users, error: null }

    users.push(...batch)
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
