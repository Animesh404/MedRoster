/**
 * Reads the Postgres SQLSTATE off an error thrown by a Prisma query, across the
 * shapes Prisma 7 + `@prisma/adapter-pg` actually produce.
 *
 * Verified against forced real deadlocks and serialization failures: Prisma 7 on
 * the pg driver adapter does NOT surface the SQLSTATE at the top-level `err.code`
 * — that field holds Prisma's own error code instead (`P2010` for a raw query,
 * `P2039` for a model operation). The underlying Postgres code is nested at
 * `err.meta.driverAdapterError.cause.code`. We check that path first and fall
 * back to `err.code` for any Prisma/driver combination that puts it there directly.
 */
export function pgCode(err: unknown): string | undefined {
  const e = err as {
    code?: string
    meta?: { driverAdapterError?: { cause?: { code?: string } } }
  }
  return e.meta?.driverAdapterError?.cause?.code ?? e.code
}

/** Retries a transaction on serialization failure and deadlock (§4.2). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = pgCode(err)
      // 40001 serialization_failure, 40P01 deadlock_detected
      if (code !== '40001' && code !== '40P01') throw err
      lastError = err
      await new Promise((r) => setTimeout(r, 10 * (i + 1) + Math.floor(Math.random() * 10)))
    }
  }
  throw lastError
}
