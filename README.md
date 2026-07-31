# MedRoster

A shift scheduler for a small clinic. Managers post the rota; staff claim the
shifts that fit. The business rules are enforced on the server, so a shift is
never double-booked or quietly left a nurse short.

The clinic's old spreadsheet is imported on first boot, and every cleaning
decision the importer made is readable in the UI.

---

## Local setup

Requires Docker. The Supabase CLI ships as a dev dependency — no global install.

```bash
npm install
npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,storage-api,postgres-meta
cp .env.example .env    # then paste the keys `npx supabase start` printed
npx prisma migrate deploy
npm run db:seed
npm run dev
```

Then open **http://localhost:3000**.

The `-x` flags skip optional services (Studio, storage, analytics) that are not
needed for auth and do not come up reliably on every machine. Postgres runs on
`54322`, the auth API on `54321`, and invite/recovery emails land in Mailpit at
<http://127.0.0.1:54324>.

Seeded credentials are unchanged — see "Sign in" below.

### Run the app in a container

`docker-compose.yml` runs just the `app` service — Postgres and auth still come
from the Supabase CLI stack above, which must already be running (`npx supabase
start ...`, as above). The container can't reach the host at `127.0.0.1`, so the
compose file points at `host.docker.internal` instead, and reads
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` out of your
`.env` (Compose loads a project-root `.env` for variable substitution automatically):

```bash
docker compose up
```

It migrates, seeds, and serves on **http://localhost:3000**.

## Sign in

Every seeded account uses the password **`medroster123`** (from `SEED_PASSWORD`).

| Role | Email | Why this one |
|---|---|---|
| Manager | `manager@clinicmail.test` | Full access — coverage, editing, import |
| Doctor | `chloe.hussain@clinicmail.test` | A doctor's view of the roster |
| Nurse | `ivy.bell@clinicmail.test` | A nurse's view — claiming and open slots |
| Receptionist | `hiro.petrova@clinicmail.test` | A receptionist's view of the roster |

The login page lists these with click-to-fill buttons, so you don't need this table.

These four are also the only imported staff with a real login: the seed gives
just this one-per-profession set an actual Supabase Auth account (email
confirmed, password set). Every other row the importer produced — roughly
thirty more staff — is deliberately left without one. A spreadsheet row was
never a login, and leaving the rest account-less is what gives the members
page (a later milestone) real people to invite.

> Zainab Volkov is also the person the importer merged: the spreadsheet filed her
> under both staff `999` and `105`, and the lower id won. That decision is visible
> in the import report.

## Members and invites

Managers invite colleagues from `/members`. An invite creates the Supabase Auth account and
emails a link; the invitee follows it, sets a password, and lands on `/dashboard` — no
signup form, because accounts are never self-service. Locally those emails never leave the
machine: they land in Mailpit at <http://127.0.0.1:54324>, readable without a real inbox.

Two things only an operator can do, and the feature is inert without them:

- **Configure custom SMTP** in the Supabase dashboard before inviting anyone real. The
  built-in mailer is capped near 2 emails/hour and only delivers to addresses on the
  project's own team — invites to real people will silently never arrive.
- **Disable "Allow new users to sign up"** in the dashboard. This gates **OAuth (Google)
  sign-in only** — an unknown email is refused. Magic link is gated separately in code
  (`shouldCreateUser: false`), not by this setting, so leaving it enabled does not open
  magic link to strangers.

## Test

```bash
npm test          # 614 unit + integration tests
npm run test:e2e  # 30 browser specs, real Chrome via Playwright
```

`npm test` needs Docker — the concurrency and persistence suites boot throwaway
Postgres containers via Testcontainers, one file at a time. The first run pulls a
Postgres image.

`npm run test:e2e` expects the app already running (`npm run build && npm start`)
and drives your installed Google Chrome rather than downloading a browser. Set
`BASE_URL` to point it elsewhere. It stays out of `npm test` on purpose: it needs
a live server and a real browser.

## What to look at

**The coverage dashboard** (`/dashboard`) is the manager's screen. Each shift
renders its staffing as literal slots — solid for held, hollow for the gap —
rather than a percentage, because what a manager is scanning for *is* the gap.
Filled and hollow differ in shape, not just colour, so it survives greyscale and
colour-blind reading. Each day column carries a spine bar coloured by its worst
status, so the week reads without opening a single card.

**The import report** (`/import`) is the honest account of what happened to the
spreadsheet. For every row: the raw source line, what was wrong, and what was
done. `staff.csv` → 34 accepted, 3 merged, 4 rejected of 41. The Janitor row
explains why a profession this clinic doesn't schedule can't be imported.

**Try to break a claim.** Sign in as the nurse demo account (Ivy Bell) and claim
something that overlaps a shift she already holds, or a role that's already
full. The refusal is the server's own message, naming the conflict — the button
flips optimistically and rolls back.

**Editing a shift with claims.** As the manager, retime a shift people have
claimed. You get a preview naming exactly who would be dropped and why, before
anything is saved.

## Stack

| | Why |
|---|---|
| Next.js 16 (App Router), React 19 | One deployable; server components for the data-heavy screens |
| Postgres + Prisma 7 | Advisory locks and the transactional guarantees the rules depend on |
| Supabase Auth, email + password | Session lives in an httpOnly cookie; role is re-derived from the `User` row on every request, not trusted from the token |
| Zod | One schema per endpoint; types inferred from it on both sides |
| Tailwind v4 + shadcn/ui | CSS-first tokens; there is no `tailwind.config.ts` |
| Supabase Realtime (optional) | Live updates; falls back to polling when unconfigured |
| Vitest + Testcontainers, Playwright | Real Postgres for concurrency; real Chrome for the flows |

## Configuration

`APP_ENV` chooses the database, so switching targets isn't a URL rewrite:

```
APP_ENV=development   ->  DATABASE_URL_DEV    (local Supabase CLI Postgres)
APP_ENV=production    ->  DATABASE_URL_PROD   (Supabase)
DATABASE_URL set      ->  wins over both
```

That override matters: `docker compose` injects a URL, Testcontainers hands each
test file a throwaway one, and CI sets its own. All three know better than
`APP_ENV` does.

`APP_ENV` is deliberately not `NODE_ENV` — Next forces that to `production` for
any production build, including one you want pointed at dev data.

### Realtime broadcasts are optional; the Supabase variables are not

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are
required — they're the input to every Supabase client, auth included, not just
realtime. Leave either unset and the app fails loudly at boot naming the
missing variable, rather than every guarded route returning an opaque 500.

What's actually optional is whether *broadcasts* fire. Broadcasts come from a
trigger on the event outbox, and that trigger installs only where a `realtime`
schema exists — so migrations apply cleanly to plain Postgres too, they just
don't emit. Without a live broadcast the app polls `/api/events/since` every 4
seconds instead and works fully; live updates are a latency improvement, not a
correctness requirement. The broadcast carries only an event id, type and
mutation id; the payload stays in the database and is served by an
authenticated endpoint.

Pointing this at your own Supabase project, three things bite:

- **Percent-encode special characters in the password.** A literal `@` breaks URI parsing.
- **Use the pooler host, not the direct one.** Direct connections are IPv6-only without the IPv4 add-on. The pooler username includes the project ref (`postgres.<ref>`).
- **Append `?sslmode=require&uselibpqcompat=true`.** node-postgres 8.16 made `sslmode=require` imply full verification, which Supabase's pooler certificate doesn't satisfy.

## Deployment

Merging to `main` deploys. Not directly — through the go-live gate in
`.github/workflows/go-live.yml`, which is the only path to production.

Vercel's own Git integration is switched **off** for `main`
(`vercel.json` → `git.deploymentEnabled.main: false`). Without that, Vercel would
ship each commit the moment it landed and the gate would be grading something
already live.

The gate runs four stages, cheapest first, and stops at the first failure:

| Stage | What it proves |
|---|---|
| **1 · verify** | Types, lint at `--max-warnings 0`, the full unit and integration suite, and a production build. |
| **2 · acceptance** | The real app against a real Supabase and a real Chrome: migrate, seed from the same dirty CSVs production uses, then the whole Playwright suite, then the SLO budgets. |
| **3 · deploy** | Applies migrations **before** the new code serves, then `vercel deploy --prod`. |
| **4 · verify-live** | The SLOs again, against production — including that the running instance reports the commit this run built. |

Stage 4 is the one that is easy to leave out and the one that catches the
failure nobody expects: a green pipeline proves the artefact was good, not that
it reached production.

### Service level objectives

`docs/SLO.md` defines four indicators — availability, latency, error rate and
deploy integrity — with the budget for each and why it is that number. Check
them against anything running:

```bash
BASE_URL=http://localhost:3100 npm run slo
```

`GET /api/health` is the availability probe. It runs a real `SELECT 1`, so it
returns 503 when the database is unreachable rather than reporting a healthy
Node process in front of a dead database. It is unauthenticated by design — the
caller is a load balancer — and says only whether the service works and which
build is answering.

### Supabase: the hosted project needs configuring too

`supabase/config.toml` configures the **local** stack only. Nothing carries it
to a hosted project, so two settings the app depends on have to be applied to
production separately — and both fail quietly if they are not:

- **`disable_signup`** — the roster is invite-only. This is layer 1 of three;
  the others (`shouldCreateUser: false` on magic link, and the roster check in
  `/auth/callback`) keep a stranger out of roster data, but without this anyone
  can create an auth account at all.
- **The three email templates** — ours pass `{{ .TokenHash }}` as a query
  parameter to `/auth/confirm`. Supabase's defaults use `{{ .ConfirmationURL }}`,
  which returns the token in the URL **fragment** — never sent to the server, so
  the route receives nothing and invites and password resets die silently after
  sending a real email.
- **Site URL and the redirect allow-list** — every emailed link is built from
  `{{ .SiteURL }}`. Left at localhost, an invite sends the recipient to a machine
  they do not have.

```bash
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=... APP_URL=https://... \
  npm run supabase:config          # apply, then read back to verify
  npm run supabase:config:check    # report drift, change nothing, exit 1
```

`SUPABASE_ACCESS_TOKEN` is a **personal access token** from Account → Access
Tokens. The `service_role` key cannot change project settings.

Still manual, because neither is a setting this app can decide for you:

- **SMTP.** Supabase's built-in sender only delivers to project members and is
  rate-limited to a handful per hour. Inviting real staff needs your own SMTP.
- **Google sign-in.** Needs a Google Cloud OAuth client, with
  `https://<ref>.supabase.co/auth/v1/callback` as the redirect URI. Decide the
  identity-linking behaviour first — see §5.4.1 of the auth design for what
  happens when a Google identity's email matches an already-invited user.

### Secrets the gate needs

Repository → Settings → Secrets and variables → Actions:

| Secret | Where to find it |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | same file |
| `DATABASE_URL_PROD` | Supabase → Project Settings → Database → connection string |

The deploy stage checks all four are present and fails with a message naming
the missing one, rather than dying deep inside the Vercel CLI with something
about linking a project.

Vercel's own environment also needs `APP_ENV=production`, `DATABASE_URL_PROD`,
`SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `CLINIC_TZ`, `CRON_SECRET` and the two
`NEXT_PUBLIC_SUPABASE_*` values.

`CRON_SECRET` should be any long random string — `vercel.json` schedules a
nightly `/api/cron/prune`, which clears expired idempotency records, drop
notices and outbox events. The route refuses to run without that secret rather
than sitting open, so leaving it unset means those tables grow unchecked.
Locally, `npm run db:prune` does the same thing.

Seed the target database once with `npm run db:seed`, so the data is present
before the first request rather than being built on demand.

## Design

`design/medroster.pen` holds the source design — 14 frames across desktop,
tablet and mobile, including loading, empty and error states, plus a motion spec.
Opens with [Pencil](https://pencil.dev).

## Decisions

`docs/REQUIREMENTS.md` states what the app has to do; `DECISIONS.md` covers the
choices worth defending: what happens to claims when a
shift is edited, how the date formats were decoded from evidence rather than
guessed, why the shift merge key includes requirements, and the concurrency
model — including the non-obvious fact that it is correct only under READ
COMMITTED.
