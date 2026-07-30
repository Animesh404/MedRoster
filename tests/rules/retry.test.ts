import { describe, expect, it, vi } from 'vitest'
import { isCapacityError, pgCode, withRetry } from '@/lib/rules/retry'

/**
 * Builds an error shaped the way Prisma 7 + `@prisma/adapter-pg` actually
 * throws: the Postgres SQLSTATE is nested under `meta.driverAdapterError.cause`,
 * NOT on `err.code` (which carries Prisma's own code instead). `pgCode` exists
 * because of that shape, so the fixtures have to honour it or these tests would
 * pass against a `pgCode` that only ever read the top level.
 */
function driverError(sqlstate: string) {
  return { code: 'P2010', meta: { driverAdapterError: { cause: { code: sqlstate } } } }
}

/** Prisma's own transaction errors arrive with the code at the top level. */
function prismaError(code: string) {
  return Object.assign(new Error(`Transaction API error: ${code}`), { code })
}

describe('pgCode', () => {
  it('prefers the nested driver-adapter SQLSTATE over Prisma-s own code', () => {
    expect(pgCode(driverError('40001'))).toBe('40001')
  })

  it('falls back to a top-level code when there is no nested cause', () => {
    expect(pgCode(prismaError('P2028'))).toBe('P2028')
  })

  it('returns undefined for an error carrying no code at all', () => {
    expect(pgCode(new Error('boom'))).toBeUndefined()
  })
})

describe('isCapacityError', () => {
  it.each([
    ['P2028', 'transaction could not start within maxWait'],
    ['P2024', 'could not get a connection from the pool'],
  ])('treats %s (%s) as a capacity signal', (code) => {
    expect(isCapacityError(prismaError(code))).toBe(true)
  })

  it.each([
    ['40001', 'serialization failure — the transaction RAN and lost'],
    ['40P01', 'deadlock — also ran'],
    ['23505', 'unique violation — a real domain conflict'],
  ])('does not treat %s (%s) as a capacity signal', (sqlstate) => {
    expect(isCapacityError(driverError(sqlstate))).toBe(false)
  })

  it('does not treat an ordinary error as a capacity signal', () => {
    expect(isCapacityError(new Error('boom'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a serialization failure and returns the eventual success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(driverError('40001'))
      .mockResolvedValue('ok')

    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries a deadlock', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(driverError('40P01'))
      .mockResolvedValue('ok')

    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // The regression this module was widened for. Before the fix P2028 fell
  // through on the FIRST attempt, so a claimant whose transaction never got to
  // start surfaced as an HTTP 500 rather than being retried or reported as
  // congestion. A `toHaveBeenCalledTimes(1)` here would mean the bug is back.
  it('retries a P2028 transaction-start timeout rather than giving up at once', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(prismaError('P2028'))
      .mockResolvedValue('ok')

    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries a P2024 pool timeout', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(prismaError('P2024'))
      .mockResolvedValue('ok')

    await expect(withRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('rethrows a non-retryable error immediately, without burning attempts', async () => {
    const fn = vi.fn().mockRejectedValue(driverError('23505'))

    await expect(withRetry(fn)).rejects.toMatchObject({
      meta: { driverAdapterError: { cause: { code: '23505' } } },
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(prismaError('P2028'))

    await expect(withRetry(fn, 3)).rejects.toMatchObject({ code: 'P2028' })
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
