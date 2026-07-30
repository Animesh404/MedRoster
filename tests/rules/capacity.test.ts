import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { assignClaim, unassignClaim } from '@/lib/rules/assign'
import { statusFor } from '@/lib/domain/errors'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

/**
 * A `$transaction` that always fails the way Prisma fails when a transaction
 * cannot START — P2028, raised before any of the callback's work runs.
 *
 * Injected at the client boundary rather than provoked with real contention on
 * purpose: reproducing a genuine P2028 needs enough concurrent claimants to
 * exhaust `maxWait`, which is slow, host-dependent, and exactly the kind of
 * load-sensitive test that made this bug hard to see in the first place. The
 * behaviour under test is the translation of the error, not the queueing that
 * produces it, so the error is the thing worth faking.
 */
function dbThatCannotStartTransactions(real: PrismaClient): PrismaClient {
  const err = Object.assign(
    new Error('Transaction API error: Unable to start a transaction in the given time.'),
    { code: 'P2028' },
  )
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return () => Promise.reject(err)
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PrismaClient
}

async function seedClaimable() {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: new Date('2026-12-01T09:00:00Z'),
      endsAt: new Date('2026-12-01T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  const nurse = await db.user.create({
    data: { email: 'busy@c.test', name: 'Nina', role: 'STAFF', profession: 'NURSE' },
  })
  return { db, shift, nurse }
}

/**
 * Regression guard for the failure in docs/KNOWN_ISSUES.md: under a burst, a
 * legitimate claimant received an HTTP 500 INTERNAL_ERROR because P2028 escaped
 * `assignClaim` entirely and was swallowed by `withAuth`'s catch-all. A 500 is
 * both wrong (nothing is broken — the server is busy) and actively harmful,
 * because the caller cannot tell "never ran" from "ran and lost" and so cannot
 * safely retry.
 */
describe('claim capacity errors', () => {
  it('reports a transaction that never started as BUSY, not an unhandled throw', async () => {
    const { db, shift, nurse } = await seedClaimable()
    const stalled = dbThatCannotStartTransactions(db)

    const result = await assignClaim({
      db: stalled, shiftId: shift.id, userId: nurse.id, actorId: nurse.id,
    })

    expect(result).toMatchObject({ code: 'BUSY' })
  })

  it('maps BUSY to 503 — retry this request — rather than 500', () => {
    expect(statusFor('BUSY')).toBe(503)
  })

  it('tells the claimant what to do, in their own words', async () => {
    const { db, shift, nurse } = await seedClaimable()
    const stalled = dbThatCannotStartTransactions(db)

    const result = await assignClaim({
      db: stalled, shiftId: shift.id, userId: nurse.id, actorId: nurse.id,
    })

    expect((result as { message: string }).message).toMatch(/try again/i)
    // No Prisma vocabulary should reach a nurse looking at a shift board.
    expect((result as { message: string }).message).not.toMatch(/P2028|transaction|prisma/i)
  })

  it('applies the same translation to releasing a shift', async () => {
    const { db, shift, nurse } = await seedClaimable()
    const stalled = dbThatCannotStartTransactions(db)

    const result = await unassignClaim({
      db: stalled, shiftId: shift.id, userId: nurse.id,
    })

    expect(result).toMatchObject({ code: 'BUSY' })
  })

  it('still throws a genuine bug rather than disguising it as congestion', async () => {
    const { db, shift, nurse } = await seedClaimable()
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction') return () => Promise.reject(new TypeError('undefined is not a function'))
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as PrismaClient

    await expect(
      assignClaim({ db: broken, shiftId: shift.id, userId: nurse.id, actorId: nurse.id }),
    ).rejects.toThrow(TypeError)
  })

  it('does not disturb the happy path', async () => {
    const { db, shift, nurse } = await seedClaimable()

    const result = await assignClaim({
      db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id,
    })

    expect(result).toMatchObject({ claimId: expect.any(Number) })
  })
})
