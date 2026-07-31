import { Prisma } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'

/**
 * Client-supplied idempotency for claim mutations.
 *
 * The failure this exists for is not database corruption — the unique index on
 * `(shiftId, userId)` already prevents a duplicate claim. It is that the CALLER
 * cannot tell "my retry is replaying a call that already succeeded" from "this
 * genuinely conflicts". A nurse taps Claim, the transaction commits, the
 * response is lost to a flaky connection, the client retries, and the old code
 * answered `ALREADY_CLAIMED` — an error for an action that worked. The
 * optimistic UI rolls back on an error, so the nurse ends up looking at a shift
 * marked unclaimed that they actually hold. The data was right; their picture
 * of it was wrong.
 *
 * Recording the outcome inside the SAME transaction as the mutation is what
 * makes this trustworthy: the answer and the effect commit together or not at
 * all, so a replay can never report a success that did not happen.
 */

/** Distinguishes the operations so one key cannot replay across them. */
export type MutationOp = 'claim' | 'release'

/**
 * Fingerprint of the request a key was minted for.
 *
 * An idempotency key belongs to one specific call. Presenting it for a
 * different call is a client bug, not a retry — and replaying regardless would
 * be worse than useless: it could hand one nurse another nurse's "you hold this
 * shift" answer for a shift they never claimed.
 */
export function mutationScope(op: MutationOp, shiftId: number, userId: number): string {
  return `${op}:${shiftId}:${userId}`
}

export const MUTATION_SCOPE_MISMATCH =
  'That request id has already been used for a different action. Please retry the action itself.'

/**
 * Looks up a previously recorded outcome for `mutationId`.
 *
 * Returns:
 *  - `{ replay: T }`      — this exact call already ran; return the value as-is.
 *  - `{ mismatch: true }` — the key exists but was minted for a different call.
 *  - `null`               — never seen; the caller should do the work.
 *
 * MUST be called inside the transaction's advisory lock. Outside it, two
 * simultaneous retries of the same key both miss, both do the work, and the
 * second fails on the primary key — turning a benign retry into an error.
 */
export async function findRecordedOutcome<T>(
  tx: Prisma.TransactionClient,
  mutationId: string,
  scope: string,
): Promise<{ replay: T } | { mismatch: true } | null> {
  const row = await tx.mutationOutcome.findUnique({ where: { mutationId } })
  if (!row) return null
  if (row.scope !== scope) return { mismatch: true }
  return { replay: row.result as T }
}

/**
 * Records the outcome of a mutation, in the caller's transaction.
 *
 * Only outcomes of transactions that COMMIT are recorded — which is exactly
 * what calling this inside the transaction body guarantees. A capacity failure
 * (`BUSY`) never runs the body at all, so nothing is written for it; that
 * matters, because caching a transient "server was busy" answer against a key
 * would make the client's retry permanently useless.
 */
export async function recordOutcome(
  tx: Prisma.TransactionClient,
  mutationId: string,
  scope: string,
  result: unknown,
): Promise<void> {
  await tx.mutationOutcome.create({
    data: { mutationId, scope, result: result as Prisma.InputJsonValue },
  })
}

/** The error returned when a key is reused for a different request. */
export function scopeMismatchError(): AppError {
  return createAppError('INVALID_INPUT', MUTATION_SCOPE_MISMATCH)
}
