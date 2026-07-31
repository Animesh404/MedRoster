import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim, unassignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const FUTURE = new Date('2026-12-01T09:00:00Z')
const FUTURE_END = new Date('2026-12-01T17:00:00Z')

async function seedShiftAndNurses(count = 2, requiredNurses = 2) {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: FUTURE_END,
      requirements: {
        create: [
          { profession: 'NURSE', requiredCount: requiredNurses },
          { profession: 'DOCTOR', requiredCount: 0 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ],
      },
    },
  })
  const nurses = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      db.user.create({
        data: { email: `n${i}@c.test`, name: `Nurse ${i}`, role: 'STAFF', profession: 'NURSE' },
      })),
  )
  return { db, shift, nurses }
}

/**
 * The scenario these tests exist for, end to end:
 *
 *   1. A nurse taps Claim. The transaction commits.
 *   2. The response is lost — a flaky connection, a backgrounded tab, a proxy
 *      timeout. The client never learns it worked.
 *   3. The client retries with the SAME mutationId it minted for the first
 *      attempt.
 *
 * Before this fix, step 3 returned ALREADY_CLAIMED — an *error* for an action
 * that had succeeded. The optimistic UI rolls back on an error, so the nurse
 * ends up looking at a shift marked unclaimed that they actually hold. The
 * database was fine; the person's picture of it was wrong.
 */
describe('claim idempotency', () => {
  it('replays the original success instead of reporting ALREADY_CLAIMED', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const nurse = nurses[0]!
    const args = { db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id, mutationId: 'mut-retry-1' }

    const first = await assignClaim(args)
    const retry = await assignClaim(args)

    expect(first).toMatchObject({ claimId: expect.any(Number) })
    expect(retry).toEqual(first)
    // And exactly one claim exists — the retry did not create a second.
    expect(await db.claim.count({ where: { shiftId: shift.id, userId: nurse.id } })).toBe(1)
  })

  it('does not emit a second realtime event on the replayed call', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const nurse = nurses[0]!
    const args = { db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id, mutationId: 'mut-retry-2' }

    await assignClaim(args)
    const afterFirst = await db.eventOutbox.count({ where: { type: 'shift.claimed' } })
    await assignClaim(args)

    expect(await db.eventOutbox.count({ where: { type: 'shift.claimed' } })).toBe(afterFirst)
  })

  it('replays a release the same way, instead of reporting NOT_CLAIMED', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const nurse = nurses[0]!
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const args = { db, shiftId: shift.id, userId: nurse.id, mutationId: 'mut-release-1' }
    const first = await unassignClaim(args)
    const retry = await unassignClaim(args)

    expect(first).toEqual({ ok: true })
    expect(retry).toEqual({ ok: true })
  })

  // Idempotency keys mean "same key, same answer" — including when the answer
  // was a refusal. A caller who genuinely wants to try again mints a new key;
  // replaying the old one must not quietly become a second attempt.
  it('replays a domain rejection rather than re-running the rules', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses(3, 1)
    const [winner, loser] = nurses as [typeof nurses[0], typeof nurses[0]]
    await assignClaim({ db, shiftId: shift.id, userId: winner.id, actorId: winner.id })

    const args = { db, shiftId: shift.id, userId: loser.id, actorId: loser.id, mutationId: 'mut-full-1' }
    const first = await assignClaim(args)
    expect(first).toMatchObject({ code: 'ROLE_FULL' })

    // The slot frees up between the two attempts.
    await unassignClaim({ db, shiftId: shift.id, userId: winner.id })

    const retry = await assignClaim(args)
    expect(retry).toEqual(first)
    expect(await db.claim.count({ where: { userId: loser.id } })).toBe(0)
  })

  it('treats a different mutationId as a genuinely new attempt', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses(3, 1)
    const [winner, loser] = nurses as [typeof nurses[0], typeof nurses[0]]
    await assignClaim({ db, shiftId: shift.id, userId: winner.id, actorId: winner.id })

    const blocked = await assignClaim({
      db, shiftId: shift.id, userId: loser.id, actorId: loser.id, mutationId: 'mut-a',
    })
    expect(blocked).toMatchObject({ code: 'ROLE_FULL' })

    await unassignClaim({ db, shiftId: shift.id, userId: winner.id })

    const fresh = await assignClaim({
      db, shiftId: shift.id, userId: loser.id, actorId: loser.id, mutationId: 'mut-b',
    })
    expect(fresh).toMatchObject({ claimId: expect.any(Number) })
  })

  // Without a mutationId there is nothing to key on, so behaviour is exactly
  // what it was before this feature existed. Existing callers are unaffected.
  it('leaves calls with no mutationId behaving as before', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const nurse = nurses[0]!

    const first = await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })
    const second = await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    expect(first).toMatchObject({ claimId: expect.any(Number) })
    expect(second).toMatchObject({ code: 'ALREADY_CLAIMED' })
  })

  // Two different people must never collide on one key, and one person's key
  // must not leak another's answer.
  it('scopes a replay to the exact call, not merely the key', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const [a, b] = nurses as [typeof nurses[0], typeof nurses[0]]

    const first = await assignClaim({
      db, shiftId: shift.id, userId: a.id, actorId: a.id, mutationId: 'shared-key',
    })
    expect(first).toMatchObject({ claimId: expect.any(Number) })

    // Same key, different claimant. Replaying `a`'s success for `b` would tell
    // `b` they hold a shift they never claimed.
    const other = await assignClaim({
      db, shiftId: shift.id, userId: b.id, actorId: b.id, mutationId: 'shared-key',
    })

    expect(other).toMatchObject({ code: 'INVALID_INPUT' })
    expect(await db.claim.count({ where: { userId: b.id } })).toBe(0)
  })

  // The whole point is surviving a retry under contention, which is exactly
  // when the two calls overlap rather than run in sequence.
  it('two simultaneous retries of one mutation produce one claim and one event', async () => {
    const { db, shift, nurses } = await seedShiftAndNurses()
    const nurse = nurses[0]!
    const args = { db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id, mutationId: 'mut-race' }

    const [a, b] = await Promise.all([assignClaim(args), assignClaim(args)])

    expect(a).toEqual(b)
    expect(a).toMatchObject({ claimId: expect.any(Number) })
    expect(await db.claim.count({ where: { shiftId: shift.id, userId: nurse.id } })).toBe(1)
    expect(await db.eventOutbox.count({ where: { type: 'shift.claimed' } })).toBe(1)
  })
})
