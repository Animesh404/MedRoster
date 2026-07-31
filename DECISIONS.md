# Decisions

The choices that shaped MedRoster, and why. Ordered roughly by how much they'd
cost to reverse.

---

## Editing a shift that already has claims

**Re-validate everything, drop only what genuinely breaks, and show the manager
exactly who before anything is saved.**

The brief left this open. Blocking the edit until the manager manually unassigns
people is safer but tedious; keeping invalid claims and flagging them lets a
double-booking persist, which contradicts the rule the rest of the system
enforces. So: `PATCH ?dryRun=1` re-runs the claim validator against the
*proposed* state and returns who would be dropped and why. The manager confirms,
and the same computation runs again under lock.

Claims are evaluated oldest-first, so when a requirement is lowered the most
recent commitments are dropped — seniority of commitment wins. Dropped staff see
a notice on their shifts page naming the shift and the reason.

**The subtle part:** the confirm carries both a shift `version` **and** a
`claimsToken` fingerprint of the claim set. Version alone is not enough, because
claiming doesn't bump the shift's version — so a claim landing between preview
and confirm would slip through and the manager would confirm a drop list that no
longer matched reality. We hit exactly that in testing.

## Concurrency: advisory locks, in a fixed order, at READ COMMITTED

Every claim runs in one transaction that takes `pg_advisory_xact_lock`s in a
**fixed global order — shift ids before user ids, each ascending** — then reads
the counts *inside* the lock. Reading before locking is the classic oversell
bug. The fixed ordering is what stops a shift edit (one shift, many users)
deadlocking against a concurrent claim (one shift, one user).

`assignClaim` is the **only** function in the codebase that creates a `Claim`
row. Staff claims, manager assignments and the seeder all go through it, which
is what makes the rules true by construction rather than by discipline.

**Non-obvious:** this is correct *only* under READ COMMITTED. Under REPEATABLE
READ, Postgres takes the transaction snapshot at the first statement — the
advisory-lock call itself — and takes it *before* the lock is granted, so every
subsequent read is stale. Measured: 12 winners on a 3-nurse shift. The isolation
level is now pinned explicitly with a regression test that reproduces the
oversell, so nobody "upgrades" it later.

Verified with 50 concurrent claimants on a 3-nurse shift: exactly 3 win, 47 get
a clear `ROLE_FULL`.

## Date formats were decoded from evidence, not guessed

`shifts.csv` mixes ISO, slash and dash dates. Rather than assume a locale:

- In the slash form the first field reaches **30**, so it must be the day → `dd/mm/yyyy`.
- In the dash form the second field reaches **27**, so the first must be the month → `mm-dd-yyyy`.
- Both readings were cross-checked against the file's monotonic `shift_id` ordering: **zero** violations across all real rows.

Where both fields exceed 12 the date is genuinely unresolvable, and the row is
rejected rather than coin-flipped.

## The merge key includes requirements

The single most consequential line in the importer. 24 groups of shifts share a
date and time but carry *different* requirements — 2026-08-04 08:00–16:00 exists
three times with different headcounts. Those are legitimately distinct shifts.
Only one pair (5053/5054) matches on date, time **and** requirements.

A merge rule keyed on the time slot alone would have silently destroyed about 40
real shifts while looking like it worked.

## Two things the importer deliberately will not do

**It never re-cases a personal name.** `ALI`, `McDonald`, `van der Berg`,
`O'Neill` are not typos. Whitespace is trimmed; letter case is left alone. Role
values *are* normalised, because they map onto a closed enum.

**It never word-parses free text.** `two nurses and a doctor` is rejected, not
interpreted. Guessing a headcount from prose is how you end up silently
understaffing a night shift.

Blank emails are also fatal — email is the login identity, so a staff row
without one cannot become an account.

## Every import decision is logged, including the boring ones

Each source line gets a report row: the raw text, the outcome, and every issue
with `before → after`. Accepted rows too, not just failures — the report is meant
to be readable as a full account of what happened to the spreadsheet, not a list
of complaints.

Issue codes are declared alongside the rules that emit them, and a test asserts
that **every code the importer can emit is documented** before it can reach a
manager. An undocumented code in the UI fails the build.

## SSE became WebSocket

The plan specified SSE. Supabase Realtime is WebSocket, so the transport
changed; the guarantees didn't. Wrapping Realtime in an SSE re-emitter would add
a hop, hold a serverless function open per viewer, and still be cut by the
platform's duration cap.

Events are written to an outbox table **inside the mutation's transaction**, and
a database trigger broadcasts them. That's what ties the event to the commit: a
rolled-back claim never emits, a committed one always does. The trigger wraps its
broadcast in an exception handler — a transient broadcast failure must never roll
back a nurse's legitimate claim. A lost broadcast is recoverable via replay; a
lost claim is not.

The outbox also gives replay: broadcast alone is at-most-once with no history, so
a reconnecting client fetches the gap by event id. With `NEXT_PUBLIC_SUPABASE_URL`
unset the app falls back to polling the same endpoint and works fully — local
Postgres has no `realtime` schema.

## The week payload is dictionary-encoded; nothing else is

The week endpoint repeats staff names and profession labels once per claim. It
now carries a `refs` dictionary and positional tuples instead — measured 54.7%
smaller on a realistic week.

The cost is a payload you can't read raw in devtools, which is why the encoder
and decoder live in one file, are round-trip tested, and this encoding is applied
to **exactly one endpoint**. Everything else stays plain readable JSON.

## Charts are single-hue, and that's a correctness decision

Colouring bars by profession failed validation. Nurse teal against the "fully
staffed" emerald measured **ΔE 4.9** for normal vision — below the floor of 15,
meaning they're effectively the same colour to everyone. With emerald, amber and
rose all reserved for status, there was no room for three safe categorical hues.

The fix was the *form*, not the palette: profession is already named on the axis,
so colouring by it is redundant encoding. Single hue, no legend, collision gone
by construction.

Relatedly, staffing status is never colour alone — each state carries a distinct
glyph and label, and the slot meter encodes by **shape** (filled vs hollow). A
rota gets printed and pinned to a wall.

## The seed goes through the real validator

Seeded claims call `assignClaim`, not the database. Slower, but it means the seed
can't produce a roster the application itself would consider invalid, and it
doubles as an end-to-end exercise of the rules engine on every boot.

`fillRatio` is tuned to **0.20**, giving 47% of slots filled — 7 fully staffed,
92 partly, 10 empty. An earlier 0.55 filled 82% and left just *one* empty shift
in 109, which made the coverage feature look unnecessary and hid one of the three
states the dashboard exists to distinguish.

## Import is idempotent; uploads are not

`docker compose up` runs migrate + seed on every boot, so the seed-time import is
skipped if it already ran. A manager's *uploaded* import always creates its own
run — that's a real audit trail, and collapsing it would lose history.

---

## One thing I'd do differently

**Persist drop notices as a first-class `Notification` model** instead of
deriving them from the event outbox.

Right now, when an edit drops someone from a shift, they learn about it from a
`shift.claims_dropped` event replayed out of `EventOutbox`. That works, but the
outbox is an infrastructure log — it's pruned, it's keyed by topic rather than by
person, and it has no read state. A staff member who doesn't log in for a week
can miss the fact that they lost a shift, which is precisely the person who most
needs to know.

A `Notification` row per affected user, with `readAt`, would survive pruning,
support a proper unread badge, and give a natural place to hang email later. It's
a small model and I'd rather have built it than the second week-payload
optimisation.

## Deactivating a member releases their future shifts, not their past ones

Offboarding revokes the Supabase session, marks the profile `deactivatedAt`, and
deletes that person's claims on shifts that have not started yet — those slots
reopen on the dashboard immediately, which is the entire point of recording that
someone has left. Claims on shifts that have already started are kept: they are a
record of who worked, and deleting them would rewrite history to make a finished
shift look understaffed.

The alternative — refusing to deactivate until a manager reassigns every held
shift — was rejected. It makes offboarding a multi-step chore at exactly the
moment someone has already walked out, and it leaves the roster claiming cover
that will not arrive.

## Reactivating a member restores their access, not their shifts

`reactivateMember` clears `deactivatedAt` and lifts the Supabase ban. It deliberately does
**not** restore the future claims that deactivation released.

Those shifts went back on the board when the member was deactivated, and a colleague may have
picked them up in the days since. Handing them back on return would silently oversell the
shift and countermand a claim somebody else is planning their week around. A returning member
comes back able to claim; they do not come back to the rota they left.

This mirrors the deactivation policy above — future claims are released because a member who
has left should stop appearing as cover — and keeps the pair symmetric in intent even though
it is asymmetric in effect.

---

## Google sign-in is deferred, and the button is gone

**Password and magic link only. OAuth is scoped for later, not half-shipped.**

A "Continue with Google" button used to sit on the login form. The provider was
never enabled on the Supabase project, so clicking it returned a 400 from
`/auth/v1/authorize` — an advertised way in that could not let anybody in. A
broken door is worse than one fewer door, so the button is removed rather than
disabled or hidden behind a flag.

What is deliberately **kept** is the OAuth plumbing in
`app/auth/callback/route.ts`. It is inert without a provider, and it carries the
roster check that makes OAuth safe to enable at all: an unknown email is refused
and the account GoTrue just minted is deleted again. Ripping that out would mean
rewriting the security-relevant half of this feature when the decision changes.

**The open question that has to be answered first**, and the reason this is a
decision rather than a toggle: what should happen when a Google identity's email
matches somebody who was already invited by email? Supabase can link the two
identities into one account, or treat them as separate — and which it does
depends on project settings rather than on anything in this repo. Linking silently
means an attacker who can create a Google account at a known clinic address may
inherit that member's roster access. Not linking means a member who accepted an
invite by email and later clicks "Continue with Google" gets a second, empty
account and cannot see their own shifts.

Neither outcome is acceptable by accident. Enabling Google means picking one
deliberately, configuring it, and testing both paths — see §5.4.1 of the auth
design.

---

## Emailed sign-in links ride the URL fragment, because the templates cannot be changed

**No custom SMTP. The app adapts to Supabase's default email templates rather
than requiring a mail provider this project is not ready to take on.**

MedRoster ships three `{{ .TokenHash }}` templates in `supabase/templates/`.
They point at `/auth/confirm`, where the **server** exchanges the hash and sets
the session cookie before anything renders. That is the better design, and it
is what runs locally.

It cannot run in production. The Supabase Management API refuses:

> Email template modification is not available for free tier projects using the
> default email provider.

So custom templates are not merely gated behind a paid plan — they are gated
behind **configuring SMTP**, which was a cost this project could not take on at
this stage. The decision was to keep the built-in mailer and make the app work
with what it sends.

### What the default templates actually do

Measured with `admin/generate_link` rather than inferred from documentation:

```
GET  https://<ref>.supabase.co/auth/v1/verify?token=…&type=recovery
303  https://<app>/auth/reset-password#access_token=…&refresh_token=…&type=recovery
```

The session arrives **after the `#`**. A browser never transmits a fragment to
the server, so every server-side route — `/auth/confirm`, `/auth/callback` —
receives a bare URL and cannot distinguish a valid link from an expired one. It
correctly concluded "no token" and told people their link was dead.

### The consequence for the code

`app/auth/hash-session-bridge.tsx` reads the fragment on the client, exchanges
it via `setSession`, and strips it from the address bar. It is mounted on the
three pages these links land on. Magic link moved off `/auth/callback` to
`/auth/complete`, because a route handler cannot render a client component and
so could never have handled a fragment at all.

Two details that are not obvious and cost a debugging cycle each:

- **`router.refresh()` does not work here.** It re-fetches the RSC payload
  before the browser client has committed its auth cookies, so the server
  re-renders the signed-out branch and nothing retries. Observed directly: the
  page sat on "this link is no longer valid" while the cookie was already
  present, and a manual reload showed the form instantly. A full
  `location.replace` carries the cookie and drops the fragment in one step.
- **Tokens are stripped on the failure path too.** A rejected token left in
  browser history is no less replayable than an accepted one.

`e2e/hash-session.spec.ts` covers this in a real browser, and has to: a
fragment is invisible to any server-side test, so a request-level assertion
cannot tell a working link from a broken one — it never receives the part that
decides.

### What this costs, and when to revisit

The built-in mailer only delivers to addresses on the Supabase project's own
team and caps near 2–3 emails per hour. **Invites to real clinic staff will not
arrive.** The flow is correct; the delivery is not.

Configuring SMTP lifts both limits at once — real delivery, and custom
templates. At that point `npm run supabase:config` installs the `TokenHash`
templates, `/auth/confirm` starts handling these links server-side again, and
the bridge becomes dead weight worth removing. Until then it is the only thing
making an emailed link work at all.

