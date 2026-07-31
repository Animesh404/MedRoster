# Known issues

## ~~Claim contention returns HTTP 500 instead of a clean rejection under load~~ — FIXED

**Status:** fixed 2026-07-31 (see the "Fix" section at the end). Kept here because
the diagnosis took two attempts and the first one was wrong in an instructive way.

Pre-existing and not auth-related; found during the Supabase Auth migration but
present well before it.

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

## Fix (2026-07-31)

All four of the above landed:

1. **`TX_OPTIONS.maxWait: 15_000`** (`lib/rules/assign.ts`) — up from Prisma's 2s default,
   which the 50-claimant burst sat right on the edge of.
2. **`withRetry` recognises P2028/P2024**, and backs off exponentially with jitter instead
   of linearly. The old 10/20/30ms schedule retried every loser inside the same narrow
   window — a thundering herd against a lock that admits one at a time.
3. **Exhaustion becomes `BUSY` → HTTP 503** with an actionable message, via `toBusyError`.
   Non-capacity errors are still rethrown, so a genuine bug is not disguised as congestion.
4. **Pool sized deliberately** (`DATABASE_POOL_MAX`, default 20) instead of inheriting
   node-postgres' default of 10.

Verification: `tests/concurrency/claim.test.ts` previously failed roughly half of
full-suite runs on this hardware; it now passes three consecutive runs. Direct coverage
lives in `tests/rules/retry.test.ts` and `tests/rules/capacity.test.ts` — the translation
is tested by injecting the error rather than provoking real contention, deliberately,
since load-dependence is exactly what made this bug hard to see.

**Not fixed, and worth knowing:** `assignClaim` still isn't idempotent from the caller's
perspective. A client that retries a `BUSY` is safe (the transaction never ran), but a
client that retries after a genuine timeout mid-transaction could still double-submit.
The unique constraint on `(shiftId, userId)` catches that today; a mutation-id-keyed
dedup would be the fuller answer.

## ~~No reactivation for a deactivated member~~ — FIXED

**Status:** fixed 2026-07-31. Kept for the reasoning; the original text follows, then the fix.

Surfaced by the final review of the account-lifecycle work.

`deactivateMember` sets `User.deactivatedAt`, bans the Supabase user, and releases future
claims. Nothing reverses it. A deactivated row renders with no action buttons, and
re-inviting does not clear `deactivatedAt` — so an invite sent to a deactivated member is
accepted by Supabase, the invitee sets a password, and `/auth/confirm` then refuses them
with "This account is no longer active."

Deliberately out of scope for that plan, but two consequences are worth knowing:

- A misclick on **Deactivate** is not undoable through the UI. The members page now disables
  row actions when its status fetch fails, which removes the most likely way to hit this by
  accident, but the underlying one-way door remains.
- `revokeInvite` is not restricted to pending invites: `DELETE /api/members/{id}/invite` on
  an accepted, active member deletes their Supabase auth user. The UI only offers it for
  `status === 'invited'`, but the API is the real boundary and it does not check.

A reactivation feature should clear `deactivatedAt`, unban the Supabase user, and leave
released claims released (they belong to whoever took them since).

### Fix

`reactivateMember` (`lib/members/deactivate.ts`) does exactly that, exposed as
`POST /api/members/{id}/reactivate` under `member:manage` and as a **Reactivate** button on
deactivated rows.

It is **deliberately asymmetric** with deactivation: the released claims are not restored.
Someone else may have picked those shifts up in the intervening days, and handing them back
would silently oversell the shift and countermand a colleague's claim. The member returns to
the roster able to claim again; they do not return to the rota they left. Nothing about
staffing changes, so no outbox events are emitted.

The unban runs before the profile write, so a failure leaves the member deactivated in both
stores — visibly incomplete and safe to retry — rather than reporting them active while they
still cannot sign in.

Both consequences listed above are also fixed:

- **`revokeInvite` now refuses an accepted member.** It checks `confirmed_at` before deleting
  the auth user, so `DELETE /api/members/{id}/invite` can no longer destroy an active
  account's access from a button labelled "revoke invite". The UI already gated on status;
  the API is the real boundary and now holds on its own.
- **Re-inviting clears `deactivatedAt`.** Previously the invite sent, the invitee set a
  password, and `/auth/confirm` then refused them — a manager saw a successful invite while
  the person could not get in.

## ~~Members list is unpaginated past 1000 accounts~~ — FIXED

**Status:** fixed 2026-07-31.

`listUsers({ perPage: 1000 })` treated a single page as the whole directory. Past one page the
remainder was dropped, and because the caller joins that list against the roster to derive
account status, a dropped user rendered as **"No account"** — a confident wrong answer rather
than an error, which is the worst failure shape available.

### Fix

`listAllAuthUsers` (`lib/supabase/list-all-users.ts`) pages until exhausted, and is used by
all **three** call sites — the members route, the invite route, and `prisma/seed.ts`. The
original note said two; the seed was missed, and it has the same bug in a worse place: it
looks the demo accounts up by scanning the directory, so on a large stack it would fail to
find an existing account and try to create a duplicate.

Two deliberate choices:

- **Termination is on a short page, not on `nextPage`/`lastPage`.** Those fields exist but
  have moved between Supabase releases; trusting one that quietly disappears would
  reintroduce exactly the silent truncation this removes. A short page is a property of the
  data.
- **A partial result is never returned.** If any page errors, the caller gets the error and an
  empty list, so it renders a failure rather than a plausible roster with people missing.

A `maxPages` guard turns a misbehaving service into a loud error rather than a hung request.

**Still true:** the `adminPort()` factory is duplicated across two route files. Both now call
the shared helper, so the paging logic itself lives in one place, but the adapter boilerplate
is still written twice.
