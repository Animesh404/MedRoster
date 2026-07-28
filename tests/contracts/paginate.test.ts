import type { User } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, paginate, type Page } from '@/lib/db/paginate'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('cursors', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42)
  })

  it('returns null for a malformed cursor rather than throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })
})

describe('paginate', () => {
  async function seed(n: number) {
    const db = await getTestDb()
    for (let i = 0; i < n; i++) {
      await db.user.create({
        data: { email: `u${i}@c.test`, name: `User ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
    }
    return db
  }

  it('walks every row exactly once across pages', async () => {
    const db = await seed(25)
    const seen: number[] = []
    let cursor: string | null = null

    do {
      // Explicit `Page<User>` annotation (rather than leaving `page` to be
      // inferred) sidesteps a TS7022 circularity: inside a `do..while` loop,
      // `cursor` is reassigned from `page.nextCursor` later in the same
      // block, so inferring `page`'s type from this call would require
      // already knowing `cursor`'s type, which is exactly what this call is
      // computing.
      const page: Page<User> = await paginate<User>({
        findMany: (args) => db.user.findMany(args), limit: 10, cursor,
      })
      seen.push(...page.items.map((u) => u.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('reports no next cursor on the final page', async () => {
    const db = await seed(5)
    const page = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: null })
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeNull()
  })

  it('does not skip a row when an earlier row is deleted mid-scroll', async () => {
    // The failure mode that offset pagination has and keyset does not.
    const db = await seed(20)
    const first = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: null })
    await db.user.delete({ where: { id: first.items[0]!.id } })
    const second = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: first.nextCursor })

    const ids = [...first.items.map((u) => u.id), ...second.items.map((u) => u.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.items).toHaveLength(10)
  })
})
