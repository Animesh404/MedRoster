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

**Follow-up, now fixed (2026-07-31):** `assignClaim` was not idempotent from the caller's
perspective. The data was never at risk — the unique index on `(shiftId, userId)` prevents a
duplicate claim — but a nurse could tap Claim, have the transaction commit, lose the response
to a flaky connection, and have the client's retry answered with `ALREADY_CLAIMED`. That is an
*error* for an action that succeeded, and the optimistic UI rolls back on an error, so they
ended up looking at a shift marked unclaimed that they actually held. Releasing a shift had the
mirror bug via `NOT_CLAIMED`.

Both halves are now in place — the server records and replays outcomes keyed on the client's
`mutationId`, and the client retries once with that **same** key when a request never lands.
Both were needed: a review caught that the server work alone fixed nothing a nurse would
notice, because the client minted a fresh key on every attempt and so never presented a retry
at all. See "Claim retries are idempotent" below.

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
  the person could not get in. Note the scope: `inviteMember` rejects anyone who still has an
  `authUserId`, so this path is only reachable for a deactivated member with **no** account
  (deactivated before accepting, or after a revoke). A deactivated member who still has an
  account is handled by Reactivate, which is the right route for them.

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

- **Termination is on an EMPTY page** — not on `nextPage`/`lastPage`, and not on a short one.
  Those fields have moved between Supabase releases, so trusting one that quietly disappears
  would reintroduce the silent truncation. A *short* page is the subtler trap, and the first
  version of this fix fell into it: "short" only means "last" if the service always honours
  the `perPage` you asked for. If it ever caps `per_page` server-side, page 1 comes back
  short, the walk stops on page 1, and the caller silently gets a fraction of the directory —
  the original bug restored, with the error path never firing. Waiting for a genuinely empty
  page is correct either way and costs one extra request.
- **A partial result is never returned.** If any page errors, the caller gets the error and an
  empty list, so it renders a failure rather than a plausible roster with people missing.

A `maxPages` guard turns a misbehaving service into a loud error rather than a hung request.

**Still true:** the `adminPort()` factory is duplicated across two route files. Both now call
the shared helper, so the paging logic itself lives in one place, but the adapter boilerplate
is written twice.

**Also worth knowing:** `revokeInvite` deliberately does NOT use this helper. It answers a
single-key question ("has this one user accepted?") and now uses `getUserById` — one request,
an exact answer, and no dependence on a listing being complete. Answering it by walking the
directory would have made a truncated read look like "user absent", and the guard fails open
on absence.

## Claim retries are idempotent — and the record grows

**Status:** implemented 2026-07-31. Not a defect; recorded because the table needs a
retention policy before this runs long in production.

`assignClaim` and `unassignClaim` record their outcome against the client's `mutationId` in
`MutationOutcome`, inside the same transaction as the mutation itself. A retry with the same
key replays the recorded answer instead of re-running the rules.

Three properties worth preserving if this is ever touched:

- **The record is written in the mutation's own transaction.** The answer and the effect
  commit together or not at all, so a replay can never report a success that did not happen.
- **The replay check runs inside the advisory lock.** Outside it, two simultaneous retries of
  one key both miss the record, both do the work, and the second dies on the primary key —
  turning a benign retry into an error.
- **Only committed outcomes are recorded.** A capacity failure (`BUSY`) never runs the
  transaction body, so nothing is written for it. That matters: caching a transient
  "server was busy" answer against a key would make the client's own retry permanently
  useless.

A key presented for a *different* request (different operation, shift, or user) is refused
with `INVALID_INPUT` rather than replayed — one nurse's key must never hand them another
nurse's answer.

**Cost, measured rather than assumed:** the replay `SELECT` and the outcome `INSERT` both sit
inside the shift's advisory lock, on the losing path as well as the winning one — which
directly inflates the queue depth `maxWait: 15_000` was sized against. A 50-claimant burst
carrying keys finishes in ~750ms with zero `BUSY`, roughly 20× inside the limit.
`tests/concurrency/burst-keyed.test.ts` is the guard; every other concurrency test passes no
key and therefore still measures the old path.

**Retention (added 2026-07-31).** `pruneMutationOutcomes` (`lib/rules/retention.ts`) deletes
records older than 24 hours, in batches with a ceiling so a backlog can never become one long
transaction or an unbounded loop. It runs three ways: on a daily Vercel cron
(`vercel.json` → `POST /api/cron/prune`, guarded by `CRON_SECRET`), via `npm run db:prune`, or
directly from the function in any other scheduler.

24h is deliberately far longer than needed — the client retries once, immediately, and the
realtime echo TTL is 60s, so the real requirement is minutes. The consequences are asymmetric:
keeping a row too long costs a few bytes; dropping one too early re-opens the bug idempotency
exists to fix.

The pruner will not contend with live claiming at this schedule and scale. At the row level it
cannot — an in-flight claim writes `createdAt = now`, which the expiry predicate never matches,
and the pruner takes no advisory lock. It does share the connection pool that turns claim
bursts into capacity errors, so "cannot contend" would be overstating it.


## EventOutbox — the lost-cursor signal is fixed; the pruning is deliberately NOT enabled

**Status:** partly fixed 2026-07-31. The signal that makes pruning *possible* is live. The
deletion is written, tested, and **not wired in**, for a reason found in review.

### What was fixed

Clients poll `WHERE id > lastId`, so a client whose cursor was deleted would ask for events
that no longer exist, receive an empty page, and conclude it was **caught up** — silently
missing every change since. That is now detectable:

1. **`OutboxWatermark`** holds the highest `EventOutbox.id` ever deleted, advanced in the
   **same transaction** as the delete, via a single `INSERT … ON CONFLICT DO UPDATE SET
   GREATEST(...)`. One statement, so the comparison and the write are atomic — a
   read-modify-write lets two overlapping runs regress the watermark and silently re-expose a
   gap.
2. **`GET /api/events/since` returns `cursorLost`** when the cursor is below the watermark, and
   advances `lastId` to the watermark rather than echoing the cursor back. Echoing it leaves the
   client below the watermark, so it reports lost again on the next poll — a resync every few
   seconds, forever, on every quiet topic.
3. **The client treats `cursorLost` like `truncated`** — adopt the cursor and `onResync()`.
   Read as optional, so a stale bundle mid-rollout behaves exactly as before.

The watermark is read **after** the rows, so the two-read race fails safe: anything already
deleted has its advance committed, so the later read must see it. The worst case is a needless
resync.

### Why the pruning is not enabled

`EventOutbox` is **not** only a replay log. It is the sole store behind:

- **`/my-shifts` drop notices** — which that page's own comment calls *"the one thing a staff
  member cannot be left to discover only by noticing a shift missing on the day."*
- **The shift-detail activity timeline.**

Deleting a row there deletes a notice a nurse may never have seen. A shift four weeks out,
dropped today, would lose its banner while the shift is still ahead of them; somebody who does
not log in for a week would never learn at all. The retention design was reasoned entirely from
the polling-client angle, and that missed these consumers completely.

`pruneEventOutbox` works and is tested — including that a failed watermark write rolls the
delete back. `app/api/cron/prune/route.ts` does not call it, and a test asserts it does not, so
it cannot be wired in by accident.

### Progress: drop notices are now durable (2026-07-31)

`DropNotice` is a real table, written in the same transaction as every drop — a shift edit that
makes someone ineligible, a shift deletion, an offboarding — through one `recordDropNotices`
helper, so a fourth drop path cannot quietly forget. The shift's times are **snapshotted** on
the row, which also retires the old trick of recovering a deleted shift's times by digging
through its `shift.created`/`shift.edited` history.

Lifecycle: **dismissible, and auto-expiring once the shift has started.** Dismissal is the
acknowledgement — without it somebody dropped from a shift four weeks out stares at the same
banner for four weeks. Auto-expiry means an unread notice cannot accumulate forever. A notice
whose `shiftStartsAt` is NULL keeps showing, because hiding it would be the silent loss this
table exists to prevent.

Existing notices were **backfilled** from `EventOutbox` in the migration — 10 real ones on the
dev database. Without that, anyone dropped shortly before the deploy would have lost their
notice at deploy time, which is precisely the harm being fixed.

### What still blocks pruning

One consumer left: the **shift-detail activity timeline** (`app/(app)/shifts/[id]/page.tsx`).
It builds from two sources — the live claim list, which is durable, and the week's event
history, which is not. Pruning would silently thin the historical half: releases, drops and
retimes older than the window would disappear while current claims stayed.

This is materially less severe than the drop-notice case. A missing notice means somebody does
not know they are not working; a thinner timeline means less context on a page that already
shows current state correctly. It may well be an acceptable trade — but it is a decision to
take deliberately, not a side effect of enabling a cron line.

`pruneEventOutbox` remains written, tested, and unwired, with a test asserting the cron leaves
the outbox alone. The table keeps growing until that decision is made.

