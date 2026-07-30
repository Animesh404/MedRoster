# Supabase Auth — Design Spec

**Date:** 2026-07-30
**Status:** Approved
**Supersedes:** the Auth row of `docs/superpowers/specs/2026-07-28-medroster-design.md` §1,
and its §6.3 session mechanics. The permission model in §6.3 survives unchanged.

Replace the Credentials/bcrypt auth stack with Supabase Auth as the identity provider, and
build the account lifecycle the current app has no answer for: invitation, acceptance,
password reset, passwordless sign-in, and offboarding.

---

## 1. Why this shape

The requirement that decided the architecture: **invite links must be emailed through
Supabase.** Supabase exposes no general-purpose email API — its mail is sent only as a side
effect of Supabase Auth actions (invite, signup confirmation, magic link, recovery).
Emailing an invite through Supabase therefore requires Supabase Auth to own identity. It is
not a mailer that can be bolted onto Auth.js.

Everything below follows from that, plus one product decision: **the clinic is invite-only.**
Nobody self-registers into a staff roster. Role and profession are therefore always chosen by
a manager and never supplied by the person signing up.

### 1.1 What is removed

- `next-auth` and `bcryptjs` (dependencies)
- `auth.ts`, `lib/auth/config.ts`, `lib/auth/edge-config.ts`
- `User.passwordHash`
- The `AuthError` handling in `app/login/actions.ts`

`lib/auth/permissions.ts` and `lib/auth/with-auth.ts` **stay**. The permission model, the
`Principal` shape, and the `WITH_AUTH_BRAND` guarantee are unaffected by who issues the
session — only the code that *produces* a `Principal` changes.

---

## 2. Where authorization truth lives

`middleware.ts` runs in the Edge Runtime, which cannot load Prisma — a constraint the current
`lib/auth/edge-config.ts` already documents at length. So role cannot be read from the
database during middleware. Two ranked sources resolve this:

| Source | Rank | Used by | Staleness |
|---|---|---|---|
| Supabase `app_metadata.role` / `.profession` (JWT claim) | **Hint** | `middleware.ts`, nav rendering, disabled controls | Up to one access-token lifetime (~1h) |
| `User` profile row (Postgres) | **Authority** | `withAuth()`, every server action, every mutation | None |

A stale token can at worst render a page a moment early. It can never authorize a mutation,
because `withAuth()` builds its `Principal` from the profile row on every API call. This is
the same split the codebase already commits to in `lib/auth/permissions.ts`: the client
disables the button, the server enforces the rule.

Role and profession live in **`app_metadata`**, never `user_metadata`. `user_metadata` is
writable by the user it describes, so a role stored there would be self-assignable.

Any change to role, profession, or active status writes both stores, so the hint self-heals
on the next token refresh.

---

## 3. Data model

Three changes to `User`, no changes to any other model:

```prisma
model User {
  // ...unchanged fields...
  authUserId    String?   @unique   // Supabase auth.users.id; NULL = profile with no account
  deactivatedAt DateTime?           // set on offboarding; the Supabase user is banned at the same time
  // passwordHash            REMOVED
}
```

`authUserId` being nullable is load-bearing, not incidental. The CSV import produces 34 staff
records; only 4 are given accounts at seed time. The other 30 are **real roster records a
manager can assign to shifts, with no login until invited** — which is both the honest model
(a spreadsheet row was never an account) and what gives the members page a population to
invite.

### 3.1 Account status is derived, not stored

| Condition | Status |
|---|---|
| `authUserId` is null | No account |
| Supabase user exists, `confirmed_at` unset | Invited |
| `deactivatedAt` is set | Deactivated |
| Otherwise | Active |

The members page makes one `admin.listUsers()` call and joins by uid in memory. Deliberately
no local mirror of invite state: two user stores drift, and the drift is invisible until it
matters.

---

## 4. Session plumbing

`@supabase/ssr` (v0.12.x) provides cookie-based sessions in three clients, each in its own
module with one purpose:

| Module | Client | Key | Reachable from |
|---|---|---|---|
| `lib/supabase/browser.ts` | `createBrowserClient` | publishable | client components |
| `lib/supabase/server.ts` | `createServerClient` | publishable | RSC, server actions, route handlers |
| `lib/supabase/admin.ts` | `createClient` | **service role** | server-only, never imported by a client-reachable module |

`middleware.ts` keeps its current responsibility — redirect unauthenticated requests to
`/login?next=…` — and gains one more: refreshing the auth cookie on every matched request,
which is what keeps sessions alive across tabs and page loads.

---

## 5. Flows

### 5.1 Invite

1. Manager submits email, name, role, profession on `/members`.
2. Server (service-role): `admin.inviteUserByEmail(email, { redirectTo: <APP_URL>/auth/accept-invite })`
   — creates the auth user and sends the email in one call.
3. Server: `admin.updateUserById(id, { app_metadata: { role, profession } })`. A separate call
   because `inviteUserByEmail`'s `data` argument writes `user_metadata`, which is untrusted
   (§2).
4. Server: create the `User` profile, or link `authUserId` onto the existing profile when
   inviting someone the CSV import already created.
5. Invitee opens the link, lands on `/auth/accept-invite`, sets a password, becomes active.

Re-inviting an already-active member is rejected. Resending to a pending invite re-issues the
email without creating a second profile.

### 5.2 Password reset

`resetPasswordForEmail(email, { redirectTo: <APP_URL>/auth/reset-password })` → the recovery
link establishes a session scoped to password change → `updateUser({ password })`.

The public form's response does not reveal whether the address exists, so it cannot be used to
enumerate staff emails.

### 5.3 Change password while signed in

Same final call, with a gate in front: Supabase's `updateUser` does **not** require the current
password, so the current password is explicitly re-verified with `signInWithPassword` first.
Without that step, an unattended signed-in browser is enough to take over an account.

### 5.4 Passwordless sign-in and the roster gate

Magic link and Google are both enabled, and both are gated to people already on the roster.
Three layers, because any single one has a hole:

1. **Public signups disabled** in the Supabase dashboard. Admin-created invites are unaffected;
   self-registration is impossible. *Dashboard configuration — see §8.*
2. **`signInWithOtp({ shouldCreateUser: false })`** — an unknown email receives nothing instead
   of silently getting an account.
3. **`/auth/callback` verification** — after the code exchange, look up a profile by email. No
   profile, or `deactivatedAt` set → sign out, delete any orphan auth user via the admin API,
   redirect to `/login` with *"This email isn't on the roster — ask a manager for an invite."*

The gate decision is implemented as a pure function, `(email, profile) → allow | reason`, so
the security-critical branch is unit-testable without a browser or a network.

**Open risk.** When a Google identity's email matches an already-invited Supabase user,
whether Supabase links them into one account or raises an identity conflict depends on the
project's email-confirmation and identity-linking settings. This will be verified against the
local stack in step 7 of §7 before the flow is considered done, and this section updated with
the observed behaviour. No claim is made here about behaviour that has not been observed.

### 5.5 Deactivation

The manager-facing decision, to be recorded in `DECISIONS.md`: **deactivation releases future
claims and preserves past ones.** A member who has left should stop appearing as cover for
shifts they will not work; their history stays intact.

One transaction:

1. Ban the Supabase user (`admin.updateUserById`, `ban_duration`) — kills the session.
2. Set `deactivatedAt`.
3. Delete claims on shifts whose `startsAt` is in the future. Past claims untouched.
4. Write `EventOutbox` rows for each affected shift, so dashboards open in other browsers see
   the released slots without a refresh — the same path every other roster mutation uses.

Step 4 is not optional polish. A release that does not emit events leaves every open dashboard
showing staffing that no longer exists.

### 5.6 Members page

Manager-only `/members`: everyone with role, profession, and derived status; invite; resend;
revoke a pending invite; deactivate.

Three permissions are added to `ALL_PERMISSIONS` and granted to `MANAGER` only:

| Permission | Covers |
|---|---|
| `member:read` | Listing members and their status |
| `member:invite` | Sending and resending an invite |
| `member:manage` | Revoking a pending invite, deactivating a member |

Because the routes are built with `withAuth()`, `tests/rbac/routes.test.ts` covers them
automatically.

---

## 6. Seed

The seed creates Supabase auth users for the four demo accounts only (manager, doctor, nurse,
receptionist — the README credentials and the e2e fixtures), via `admin.createUser` with
`email_confirm: true` and `SEED_PASSWORD`, stamps their `app_metadata`, and links
`authUserId`. The remaining 30 imported staff are profiles without accounts.

The login page's demo buttons are unchanged — they fill and submit the real sign-in form.

Seeding now requires `SUPABASE_SERVICE_ROLE_KEY` and a reachable Supabase instance (the local
stack in development).

---

## 7. Sequencing

1. Supabase CLI local stack, env, service-role client. Prove `supabase start` works before
   anything depends on it.
2. Migration: add `authUserId` and `deactivatedAt`, drop `passwordHash`.
3. Swap the session layer: `@supabase/ssr`, `middleware.ts`, `withAuth` principal resolution;
   remove `next-auth` and `bcryptjs`.
4. **Checkpoint: login, logout, seed, and the entire existing suite green, with zero new
   features visible.** If this branch is ever abandoned, this is the line to abandon it on.
5. Invite, accept-invite, members page.
6. Password reset and change password.
7. Magic link, Google, roster gate — including the §5.4 verification.
8. Deactivation with claim release and outbox events.
9. README, `.env.example`, `DECISIONS.md`.

---

## 8. Configuration owned by the operator

The feature is inert without both of these, and neither can be done in code:

- **Custom SMTP** in the Supabase dashboard. The built-in mailer is capped near 2 emails/hour
  and only delivers to project team addresses — invites to real people will silently fail to
  arrive.
- **Public signups disabled** in the dashboard. This is layer one of the roster gate (§5.4).

Both are documented in the README.

### 8.1 Environment

Added: `SUPABASE_SERVICE_ROLE_KEY` (server-only, never `NEXT_PUBLIC_`), `APP_URL` (for
`redirectTo` targets).
Existing and reused: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
Removed: `AUTH_SECRET`, `AUTH_TRUST_HOST`.

---

## 9. Local development

`supabase start` replaces the docker-compose Postgres, running GoTrue, Postgres, and a mail
catcher locally. Invite and recovery emails are readable offline, so the full invite loop is
testable and e2e tests need no network.

`docker-compose.yml` keeps the app service but drops its own `db` service and its
`AUTH_SECRET` environment entry, pointing `DATABASE_URL` and the Supabase variables at the
CLI stack instead. The one-command setup becomes `supabase start && docker compose up`.

The Supabase CLI becomes a prerequisite; it is not currently installed on the development
machine. The README's setup command changes accordingly.

---

## 10. Testing

Known breakage from step 3, repaired in that step rather than left to leak: every module
importing `@/auth`, `tests/rbac/routes.test.ts`, the UI tests that stub a session, and the e2e
login fixture.

New coverage:

- **Roster gate** — pure function, table-driven: unknown email, deactivated member, active
  member, profile without `authUserId`.
- **Deactivation** — against Testcontainers: future claims released, past claims intact,
  outbox rows written.
- **Permissions** — the three `member:*` entries; RBAC route coverage follows automatically.
- **Service-role containment** — assert no client-reachable module imports
  `lib/supabase/admin.ts`, in the spirit of `WITH_AUTH_BRAND`. A leaked service key is the one
  mistake in this design that cannot be walked back, so it gets a test rather than a comment.
- **End-to-end invite loop** — invite an address, read the link from the local mail catcher,
  accept, set a password, sign in. Offline, in CI.

---

## 11. Production cutover

The deployed database is seeded from the CSVs, so it is re-seeded and **no password migration
is required**. Existing bcrypt hashes are discarded with the column.

This is a deliberate omission, not an oversight: had there been real users, the path would be
Supabase's bcrypt hash import (`admin.createUser` accepts a `password_hash`), and the cutover
would need a dual-read window instead.

---

## 12. Scope note

`PROJECT_BRIEF.md` §1 asks only for two roles and seeded logins, both of which the current
implementation already satisfies. This work is beyond the brief. It is justified by the
brief's stated judging criterion — the product as a whole — and by the fact that a scheduler
with no way to add a member is a demo rather than an application. The cost is real: roughly
twenty files, a migration, a seed rewrite, and every e2e login fixture.
