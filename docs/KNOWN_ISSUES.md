# Known issues

## Claim contention returns HTTP 500 instead of a clean rejection under load

**Status:** open, pre-existing, not auth-related. Found during the Supabase Auth
migration (2026-07-31) but present well before it.

**Symptom.** `tests/concurrency/claim.test.ts` > "lets exactly 3 of 50 simultaneous
nurses onto a 3-nurse shift" fails intermittently (~50% of full-suite runs) while
passing 8/8 in isolation.

**Mechanism.** Reproduced directly with 200 concurrent `assignClaim` calls against a
Testcontainers Postgres on an *unloaded* machine: 12 of 200 were rejected with

```
P2028  Transaction API error: Unable to start a transaction in the given time.
```

That is Prisma's interactive-transaction `maxWait` (2000 ms default) — the transaction
never begins. `pgCode()` returns `'P2028'`, which `withRetry` (`lib/rules/retry.ts`)
rethrows immediately because it only retries SQLSTATE `40001`/`40P01`. No retries are
consumed.

The real cause is admission control, not the retry budget:

- `lib/db/client.ts` constructs `PrismaPg` with no pool sizing (node-postgres defaults
  to max 10 connections).
- `withOrderedLocks` serialises every claimant of a shift behind one
  `pg_advisory_xact_lock`.
- Blocked transactions hold a connection while waiting, so the queue drains one
  claimant at a time and everyone else burns `maxWait`, then `timeout`.

Host CPU load lengthens per-claim work and drops the breaking point from ~200
concurrent to ~50, which is why the test flakes only under full-suite load.

**Why it matters in production.** A "shift drop" — every eligible staff member hitting
one shift at once — is precisely this app's design case. At 200 claimants on idle
hardware, 6% received a 500 `INTERNAL_ERROR` where they should have seen a clean
`ROLE_FULL`. Worse, `assignClaim` is not idempotent from the caller's perspective on a
500, so a retrying client cannot distinguish "did not run" from "ran and lost".

**Where to fix** — `lib/rules/assign.ts` and `lib/db/client.ts`, NOT `retry.ts`:

1. Pass explicit `maxWait`/`timeout` on the claim transaction (`TX_OPTIONS` currently
   sets only `isolationLevel`; `lib/seed/run-seed.ts` already overrides `timeout`
   elsewhere, so the codebase knows this knob exists).
2. Size the pg pool deliberately rather than inheriting the default of 10.
3. Most important: map `P2028`/`P2024` to a retryable or `BUSY` domain error instead of
   letting it reach the client as a 500.

An earlier diagnosis attributed this to `withRetry`'s 3-attempt budget. That was wrong —
raising `attempts` would change nothing, because the failing code is never retried.
