import { describe, expect, it, vi } from 'vitest'
import { listAllAuthUsers, type PagedListUsers } from '@/lib/supabase/list-all-users'

/**
 * A fake `admin.listUsers` holding `total` users, served in pages of `perPage`.
 *
 * Supabase pages are 1-indexed. Note this fake honours `perPage` exactly — the
 * separate capped-page-size test below models a service that does NOT, which
 * is the case a stop-on-short-page walk gets wrong.
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
    // Two requests, not one: the second confirms the directory is exhausted.
    // Trusting the first short page instead is precisely the bug below.
    expect(calls).toHaveLength(2)
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

  it('asks for pages 1..n in order, and stops on the first empty page', async () => {
    const { listUsers, calls } = fakeListUsers(2500)

    await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(calls.map((c) => c.page)).toEqual([1, 2, 3, 4])
  })

  // Terminating on an EMPTY page means the walk always spends one request
  // learning it is done, whether or not the total divides evenly. That is the
  // deliberate cost of not trusting a short page to mean "last".
  it('terminates when the total is an exact multiple of the page size', async () => {
    const { listUsers, calls } = fakeListUsers(2000)

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.users).toHaveLength(2000)
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3])
  })

  // The trap an earlier version of this helper fell into. If the service caps
  // `per_page` server-side below what we asked for, EVERY page is "short" — so
  // a stop-on-short-page walk halts on page 1 and silently returns a fraction
  // of the directory, with no error. Waiting for a genuinely empty page is
  // immune to that, and this test is what pins it.
  it('does not stop early when the service caps the page size below what was asked', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `uid-${i + 1}` }))
    const SERVER_CAP = 50

    const listUsers: PagedListUsers = (params) => {
      const perPage = Math.min(params?.perPage ?? 50, SERVER_CAP) // the cap
      const start = ((params?.page ?? 1) - 1) * perPage
      return Promise.resolve({ data: { users: all.slice(start, start + perPage) }, error: null })
    }

    const result = await listAllAuthUsers(listUsers, { perPage: 1000 })

    expect(result.error).toBeNull()
    expect(result.users).toHaveLength(250)
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
