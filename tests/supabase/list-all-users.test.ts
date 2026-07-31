import { describe, expect, it, vi } from 'vitest'
import { listAllAuthUsers, type PagedListUsers } from '@/lib/supabase/list-all-users'

/**
 * A fake `admin.listUsers` holding `total` users, served in pages of `perPage`.
 *
 * Deliberately models the real contract's awkward part: Supabase pages are
 * 1-indexed, and the only reliable end-of-list signal is a page shorter than
 * `perPage` (`nextPage`/`lastPage` are present but have varied across
 * versions, so relying on them is how you get a silent truncation on upgrade).
 */
function fakeListUsers(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({
    id: `uid-${i + 1}`,
    email: `user${i + 1}@c.test`,
  }))
  const calls: { page?: number; perPage?: number }[] = []

  const listUsers: PagedListUsers = (params) => {
    calls.push({ ...params })
    const perPage = params?.perPage ?? 50
    const page = params?.page ?? 1
    const start = (page - 1) * perPage
    return Promise.resolve({
      data: { users: all.slice(start, start + perPage) },
      error: null,
    })
  }

  return { listUsers, calls, all }
}

describe('listAllAuthUsers', () => {
  it('returns everyone when they fit in a single page', async () => {
    const { listUsers, calls } = fakeListUsers(35)

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.error).toBeNull()
    expect(result.users).toHaveLength(35)
    expect(calls).toHaveLength(1)
  })

  // The bug this exists for. The old code asked for a single page of 1000 and
  // treated whatever came back as the whole population — so member 1001
  // silently rendered as "No account", a wrong answer rather than an error.
  it('pages past the first page instead of silently truncating', async () => {
    const { listUsers } = fakeListUsers(2500)

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.users).toHaveLength(2500)
    expect(new Set(result.users.map((u) => u.id)).size).toBe(2500)
  })

  it('asks for pages 1..n in order, and stops on the first short page', async () => {
    const { listUsers, calls } = fakeListUsers(2500)

    await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(calls.map((c) => c.page)).toEqual([1, 2, 3])
  })

  // An exact multiple has no short page to stop on, so the walk only ends when
  // a page comes back empty. Off-by-one here would either drop the last page or
  // loop forever.
  it('terminates when the total is an exact multiple of the page size', async () => {
    const { listUsers, calls } = fakeListUsers(2000)

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.users).toHaveLength(2000)
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3])
  })

  it('handles an empty directory', async () => {
    const { listUsers } = fakeListUsers(0)

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.users).toEqual([])
  })

  // A partial result is worse than no result: the caller renders real members
  // as "No account", which reads as fact rather than failure. Surface it.
  it('surfaces an error from a later page rather than returning a partial list', async () => {
    const boom = { message: 'rate limited' }
    const listUsers = vi.fn<PagedListUsers>()
      .mockResolvedValueOnce({ data: { users: Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` })) }, error: null })
      .mockResolvedValueOnce({ data: { users: [] }, error: boom })

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.error).toBe(boom)
    expect(result.users).toEqual([])
  })

  it('surfaces an error from the very first page', async () => {
    const boom = { message: 'unauthorized' }
    const listUsers = vi.fn<PagedListUsers>()
      .mockResolvedValue({ data: { users: [] }, error: boom })

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.error).toBe(boom)
    expect(result.users).toEqual([])
  })

  // A runaway guard, not a feature: if the service ever returned full pages
  // forever, an unbounded walk would hang the request rather than fail it.
  it('stops at the page cap and reports an error instead of looping forever', async () => {
    const listUsers = vi.fn<PagedListUsers>().mockImplementation((params) =>
      Promise.resolve({
        data: { users: Array.from({ length: params?.perPage ?? 50 }, (_, i) => ({ id: `x${i}` })) },
        error: null,
      }),
    )

    const result = await listAllAuthUsers(listUsers, { perPage: 10, maxPages: 5 })

    expect(result.error).toBeTruthy()
    expect(String((result.error as { message: string }).message)).toMatch(/too many/i)
    expect(listUsers).toHaveBeenCalledTimes(5)
  })
})
