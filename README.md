# MedRoster

A shift scheduler for a small clinic. Managers post the rota; staff claim the
shifts that fit. The business rules are enforced on the server, so a shift is
never double-booked or quietly left a nurse short.

The clinic's old spreadsheet is imported on first boot, and every cleaning
decision the importer made is readable in the UI.

---

## Run it

One command. Brings up Postgres, migrates, seeds from the CSVs, and serves the app:

```bash
cp .env.example .env      # then set AUTH_SECRET — `openssl rand -base64 32`
docker compose up
```

Then open **http://localhost:3000**.

Prefer to run it directly:

```bash
docker compose up -d db   # Postgres only
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

## Sign in

Every seeded account uses the password **`medroster123`** (from `SEED_PASSWORD`).

| Role | Email | Why this one |
|---|---|---|
| Manager | `manager@clinicmail.test` | Full access — coverage, editing, import |
| Nurse | `zainab.volkov@clinicmail.test` | Holds **16** shifts, so overlap rejections fire immediately |
| Doctor | `omar.patel@clinicmail.test` | Sees a different set of open slots |
| Receptionist | `hiro.iyer@clinicmail.test` | The role most shifts don't need — shows an empty rail |

The login page lists these with click-to-fill buttons, so you don't need this table.

> Zainab Volkov is also the person the importer merged: the spreadsheet filed her
> under both staff `999` and `105`, and the lower id won. That decision is visible
> in the import report.

## Test

```bash
npm test          # 441 unit + integration tests
npm run test:e2e  # 27 browser specs, real Chrome via Playwright
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

**Try to break a claim.** Sign in as Zainab and claim something that overlaps a
shift she already holds, or a role that's already full. The refusal is the
server's own message, naming the conflict — the button flips optimistically and
rolls back.

**Editing a shift with claims.** As the manager, retime a shift people have
claimed. You get a preview naming exactly who would be dropped and why, before
anything is saved.

## Stack

| | Why |
|---|---|
| Next.js 16 (App Router), React 19 | One deployable; server components for the data-heavy screens |
| Postgres + Prisma 7 | Advisory locks and the transactional guarantees the rules depend on |
| Auth.js v5, credentials + bcrypt | Role rides in the JWT, so permission checks need no DB round-trip |
| Zod | One schema per endpoint; types inferred from it on both sides |
| Tailwind v4 + shadcn/ui | CSS-first tokens; there is no `tailwind.config.ts` |
| Supabase Realtime (optional) | Live updates; falls back to polling when unconfigured |
| Vitest + Testcontainers, Playwright | Real Postgres for concurrency; real Chrome for the flows |

## Configuration

`APP_ENV` chooses the database, so switching targets isn't a URL rewrite:

```
APP_ENV=development   ->  DATABASE_URL_DEV    (local Docker Postgres)
APP_ENV=production    ->  DATABASE_URL_PROD   (Supabase)
DATABASE_URL set      ->  wins over both
```

That override matters: `docker compose` injects a URL, Testcontainers hands each
test file a throwaway one, and CI sets its own. All three know better than
`APP_ENV` does.

`APP_ENV` is deliberately not `NODE_ENV` — Next forces that to `production` for
any production build, including one you want pointed at dev data.

### Realtime is optional

Without `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
the app polls `/api/events/since` every 4 seconds and works fully. Live updates
are a latency improvement, not a correctness requirement.

Broadcasts come from a trigger on the event outbox, and that trigger installs
only where a `realtime` schema exists — so migrations apply cleanly to plain
Postgres too, they just don't emit. The broadcast carries only an event id, type
and mutation id; the payload stays in the database and is served by an
authenticated endpoint.

Pointing this at your own Supabase project, three things bite:

- **Percent-encode special characters in the password.** A literal `@` breaks URI parsing.
- **Use the pooler host, not the direct one.** Direct connections are IPv6-only without the IPv4 add-on. The pooler username includes the project ref (`postgres.<ref>`).
- **Append `?sslmode=require&uselibpqcompat=true`.** node-postgres 8.16 made `sslmode=require` imply full verification, which Supabase's pooler certificate doesn't satisfy.

## Deployment

Not currently deployed to a public URL. The Supabase database is migrated and
seeded and the app runs against it; only the hosting step is outstanding.

To deploy on Vercel: set `APP_ENV=production`, `DATABASE_URL_PROD`,
`AUTH_SECRET`, `CLINIC_TZ` and the two `NEXT_PUBLIC_SUPABASE_*` values, then run
`npm run db:migrate && npm run db:seed` against the target once. Seeding happens
at deploy time rather than on demand, so the data is present before the first
request and there is no cold-start penalty on the paths that matter.

## Design

`design/medroster.pen` holds the source design — 14 frames across desktop,
tablet and mobile, including loading, empty and error states, plus a motion spec.
Opens with [Pencil](https://pencil.dev).

## Decisions

`DECISIONS.md` covers the choices worth defending: what happens to claims when a
shift is edited, how the date formats were decoded from evidence rather than
guessed, why the shift merge key includes requirements, and the concurrency
model — including the non-obvious fact that it is correct only under READ
COMMITTED.
