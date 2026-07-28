# MedRoster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clinic shift scheduler where managers create shifts and staff claim them under server-enforced business rules, pre-populated by a CSV import pipeline whose every cleaning decision is auditable.

**Architecture:** A single Next.js 15 App Router application over Postgres via Prisma. All shift-mutating logic funnels through one `validateAssignment` validator called inside advisory-locked transactions, so capacity and overlap rules hold identically for staff claims, manager assignments, and post-edit re-validation. CSV cleaning lives in a pure, DB-free `lib/import/` module driven by a rule registry, shared by the seed, the manager upload endpoint, and the tests. Realtime fan-out rides Supabase Realtime Broadcast, emitted from a trigger on a transactional event outbox.

**Tech Stack:** Next.js 15 (App Router, TypeScript strict), Prisma + Postgres (Supabase), Auth.js v5 (credentials + bcrypt), Zod, Tailwind + shadcn/ui, Supabase Realtime, Vitest + Testcontainers, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-07-28-medroster-design.md` — read it before starting. Section references below (§4.1, §5.3, …) point into it.

## Global Constraints

- TypeScript `strict: true`. No `any` in committed code; use `unknown` + narrowing.
- **Zod schemas in `lib/contracts/` are the single source of truth for every request and response shape.** No hand-written TypeScript interface may duplicate a schema — derive with `z.infer`.
- **No code path other than `assignClaim()` may create a `Claim` row.** Not the seed, not tests, not admin scripts.
- **Every route handler and server action must be wrapped in `withAuth(permission, handler)`.** A handler that does not declare a permission is a build failure.
- Professions are exactly `DOCTOR | NURSE | RECEPTIONIST`. Roles are exactly `MANAGER | STAFF`.
- Clinic timezone comes from `process.env.CLINIC_TZ`, default `Europe/London`. Never call `new Date(string)` on a clinic-local wall-clock value; always go through `lib/domain/time.ts`.
- All timestamps persist as `timestamptz` holding UTC instants.
- Personal names are never re-cased — only whitespace-trimmed (§5.4).
- Shift merge keys always include requirements (§5.4). Never merge on date+time alone.
- Money/count fields are integers. No floats anywhere.
- Commit after every task. Conventional Commits (`feat:`, `test:`, `fix:`, `chore:`, `docs:`).
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## Expected Import Result (regression anchor)

These numbers are asserted by a golden-file test in Task 7 and must never drift:

| File | Accepted (incl. repaired) | Merged | Rejected | Total |
|---|---|---|---|---|
| `staff.csv` | 34 | 3 | 4 | 41 |
| `shifts.csv` | 109 | 2 | 6 | 117 |

Rejected staff ids: `995` (blank email), `996` (blank name), `997` (unknown profession `Janitor`), `998` (email collides with staff 107).
Rejected shift ids: `5109` (18h), `5110` (`2026-02-30`), `5112` (24h), `5113` (free-text requirements), `5114` (missing start), `5115` (26h).
Merged staff ids: `103` and `110` (byte-identical duplicate rows), `999` (same person as `105`, lowest id wins).
Merged shift ids: `5020` (byte-identical duplicate row), `5054` (identical to `5053` incl. requirements).

## File Structure

```
lib/
  domain/
    profession.ts        Profession/Role enums, alias tables, parse helpers
    time.ts              clinic-local <-> UTC, overlap, duration, ISO week
    errors.ts            AppError catalog factory, RuleCode union
  import/
    issues.ts            Issue type, severity, outcome derivation
    registry.ts          createFieldRule / createRowValidator factories
    csv.ts               RFC4180-ish splitter -> RawRow[]
    staff.ts             staff pipeline (normalize/coerce/validate)
    shifts.ts            shift pipeline (dates, times, requirements)
    reconcile.ts         dedup + merge for both file kinds
    index.ts             runImport(text, kind) -> ImportResult   [pure, no DB]
    apply.ts             applyImport(tx, result)                 [only DB writer]
  rules/
    validate.ts          validateAssignment  (§4.1)
    locks.ts             withOrderedLocks    (§4.2)
    assign.ts            assignClaim / unassignClaim — sole Claim writers
    edit.ts              previewShiftEdit / commitShiftEdit (§4.3, §4.4)
  auth/
    permissions.ts       Permission union, ROLE_PERMISSIONS catalog
    with-auth.ts         withAuth wrapper
    config.ts            Auth.js v5 config
  contracts/
    common.ts            envelope, cursor page, error shape
    week.ts              week request/response + compressed codec (§6.2)
    shifts.ts  claims.ts imports.ts staff.ts events.ts
  events/
    outbox.ts            emitEvent(tx, …) — writes EventOutbox
    topics.ts            weekTopic(date) -> "week:2026-W33"
  db/
    client.ts            Prisma singleton
    paginate.ts          keyset cursor helpers (§6.4)
prisma/
  schema.prisma
  migrations/
  seed.ts                import + deterministic claim seeder (§7.2)
app/
  (marketing)/page.tsx           landing
  login/page.tsx
  (app)/dashboard/page.tsx       week grid
  (app)/shifts/new/page.tsx
  (app)/shifts/[id]/page.tsx
  (app)/my-shifts/page.tsx
  (app)/import/page.tsx
  (app)/import/[runId]/page.tsx
  api/…                          route handlers per §6.5
components/
  ui/                    shadcn primitives
  skeletons/             skeletons built from the same primitives (§8.4)
  week-grid/  shift/  import/
hooks/
  use-realtime.ts        subscribe, echo suppression, replay, resync (§7.1)
  use-optimistic-claim.ts
tests/
  import/  rules/  contracts/  rbac/  concurrency/
```

**Decomposition rationale:** `lib/import/` is pure and DB-free so the entire rules table is testable without Postgres — `apply.ts` is the only file in it that touches the database. `lib/rules/` is split so `validate.ts` stays a pure predicate over already-loaded data, while `assign.ts` owns transactions and locking; this keeps the validator trivially unit-testable and makes "only `assignClaim` writes Claims" enforceable by inspection.

---

### Task 1: Scaffold, tooling, Docker, test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `docker-compose.yml`, `Dockerfile`, `.env.example`, `.gitignore`, `tailwind.config.ts`, `app/layout.tsx`, `app/page.tsx`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (Vitest), `npm run dev`, `docker compose up`. Path alias `@/*` → repo root.

- [ ] **Step 1: Scaffold Next.js**

```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir=false \
  --import-alias "@/*" --eslint --no-turbopack --use-npm
```

Answer "No" if it asks to overwrite `README.md` — the existing one is kept.

- [ ] **Step 2: Install dependencies**

```bash
npm i @prisma/client zod next-auth@beta bcryptjs @supabase/supabase-js clsx tailwind-merge
npm i -D prisma vitest @vitejs/plugin-react vite-tsconfig-paths @types/bcryptjs \
  @testcontainers/postgresql testcontainers dotenv-cli
```

- [ ] **Step 3: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000, // Testcontainers pulls an image on first run
  },
})
```

Add to `package.json` scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "db:migrate": "prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts"
}
```

- [ ] **Step 4: Enable TypeScript strict mode**

In `tsconfig.json` confirm `"strict": true` and add:

```json
{ "compilerOptions": { "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true } }
```

- [ ] **Step 5: Write the smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('resolves the @/ path alias', async () => {
    const mod = await import('@/lib/domain/version')
    expect(mod.APP_NAME).toBe('MedRoster')
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '@/lib/domain/version'`

- [ ] **Step 7: Create the module**

Create `lib/domain/version.ts`:

```ts
export const APP_NAME = 'MedRoster'
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 9: Write docker-compose**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: medroster
      POSTGRES_PASSWORD: medroster
      POSTGRES_DB: medroster
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U medroster']
      interval: 3s
      timeout: 3s
      retries: 20

  app:
    build: .
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgresql://medroster:medroster@db:5432/medroster
      AUTH_SECRET: local-dev-secret-change-me
      CLINIC_TZ: Europe/London
      SEED_PASSWORD: medroster123
    ports: ['3000:3000']
    command: sh -c "npx prisma migrate deploy && npx tsx prisma/seed.ts && npm run start"

volumes:
  pgdata:
```

Create `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
EXPOSE 3000
```

- [ ] **Step 10: Create `.env.example`**

```
DATABASE_URL=postgresql://medroster:medroster@localhost:5432/medroster
AUTH_SECRET=change-me
CLINIC_TZ=Europe/London
SEED_PASSWORD=medroster123
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app, Vitest harness and Docker Compose

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Prisma schema and initial migration

**Files:**
- Create: `prisma/schema.prisma`, `lib/db/client.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: Task 1's `DATABASE_URL`.
- Produces: Prisma client at `@/lib/db/client` exporting `prisma`. Models `User`, `Shift`, `ShiftRequirement`, `Claim`, `ShiftSeries`, `ImportRun`, `ImportRowResult`, `EventOutbox`. Enums `Role`, `Profession`, `ImportSource`, `FileKind`, `RowOutcome`.

- [ ] **Step 1: Write the schema**

Create `prisma/schema.prisma`:

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role         { MANAGER STAFF }
enum Profession   { DOCTOR NURSE RECEPTIONIST }
enum ImportSource { SEED UPLOAD }
enum FileKind     { STAFF SHIFT }
enum RowOutcome   { ACCEPTED REPAIRED MERGED REJECTED }

model User {
  id            Int         @id @default(autoincrement())
  email         String      @unique
  name          String
  passwordHash  String
  role          Role
  profession    Profession?
  externalId    Int?        @unique
  createdAt     DateTime    @default(now())

  claims        Claim[]     @relation("ClaimHolder")
  assignedBy    Claim[]     @relation("ClaimAssigner")
  importRuns    ImportRun[]
}

model Shift {
  id                  Int      @id @default(autoincrement())
  startsAt            DateTime @db.Timestamptz(3)
  endsAt              DateTime @db.Timestamptz(3)
  version             Int      @default(0)
  seriesId            Int?
  detachedFromSeries  Boolean  @default(false)
  externalId          Int?     @unique
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  series        ShiftSeries?       @relation(fields: [seriesId], references: [id], onDelete: SetNull)
  requirements  ShiftRequirement[]
  claims        Claim[]

  @@index([startsAt, endsAt])
  @@index([seriesId])
}

model ShiftRequirement {
  id            Int        @id @default(autoincrement())
  shiftId       Int
  profession    Profession
  requiredCount Int

  shift Shift @relation(fields: [shiftId], references: [id], onDelete: Cascade)

  @@unique([shiftId, profession])
}

model Claim {
  id           Int      @id @default(autoincrement())
  shiftId      Int
  userId       Int
  assignedById Int?
  createdAt    DateTime @default(now())

  shift      Shift @relation(fields: [shiftId], references: [id], onDelete: Cascade)
  user       User  @relation("ClaimHolder",  fields: [userId],       references: [id], onDelete: Cascade)
  assignedBy User? @relation("ClaimAssigner", fields: [assignedById], references: [id], onDelete: SetNull)

  @@unique([shiftId, userId])
  @@index([userId])
}

model ShiftSeries {
  id           Int      @id @default(autoincrement())
  weekdays     Int[]                       // 0=Sun … 6=Sat
  startTime    String                      // "08:00" clinic-local
  endTime      String                      // "16:00" clinic-local
  untilDate    DateTime @db.Date
  requirements Json                        // { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }
  createdAt    DateTime @default(now())

  shifts Shift[]
}

model ImportRun {
  id        Int          @id @default(autoincrement())
  source    ImportSource
  fileKind  FileKind
  filename  String
  actorId   Int?
  stats     Json
  createdAt DateTime     @default(now())

  actor User?             @relation(fields: [actorId], references: [id], onDelete: SetNull)
  rows  ImportRowResult[]

  @@index([createdAt])
}

model ImportRowResult {
  id          Int        @id @default(autoincrement())
  importRunId Int
  rowNumber   Int
  rawRow      String
  outcome     RowOutcome
  issues      Json
  entityId    Int?

  run ImportRun @relation(fields: [importRunId], references: [id], onDelete: Cascade)

  @@index([importRunId, rowNumber])
}

model EventOutbox {
  id         BigInt   @id @default(autoincrement())
  topic      String
  type       String
  payload    Json
  mutationId String?
  createdAt  DateTime @default(now())

  @@index([topic, id])
}
```

- [ ] **Step 2: Create the Prisma client singleton**

Create `lib/db/client.ts`:

```ts
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
```

- [ ] **Step 3: Write the schema test**

Create `tests/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'

describe('prisma schema', () => {
  const models = Prisma.dmmf.datamodel.models
  const byName = (n: string) => models.find((m) => m.name === n)

  it('defines every model the spec requires', () => {
    for (const n of ['User','Shift','ShiftRequirement','Claim','ShiftSeries','ImportRun','ImportRowResult','EventOutbox']) {
      expect(byName(n), `missing model ${n}`).toBeDefined()
    }
  })

  it('makes a user unable to hold the same shift twice', () => {
    expect(byName('Claim')!.uniqueFields).toContainEqual(['shiftId', 'userId'])
  })

  it('allows only one requirement row per profession per shift', () => {
    expect(byName('ShiftRequirement')!.uniqueFields).toContainEqual(['shiftId', 'profession'])
  })

  it('versions shifts so edit previews can detect concurrent writes', () => {
    expect(byName('Shift')!.fields.find((f) => f.name === 'version')).toBeDefined()
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- tests/schema.test.ts`
Expected: FAIL — `@prisma/client` has no generated DMMF yet.

- [ ] **Step 5: Generate the client and create the migration**

```bash
docker compose up -d db
npx prisma generate
npx dotenv -e .env -- npx prisma migrate dev --name init
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test -- tests/schema.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add prisma lib/db tests/schema.test.ts
git commit -m "feat: add Prisma schema for shifts, claims, imports and event outbox

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Domain primitives — professions, clinic time, errors

**Files:**
- Create: `lib/domain/profession.ts`, `lib/domain/time.ts`, `lib/domain/errors.ts`
- Test: `tests/domain/time.test.ts`, `tests/domain/profession.test.ts`

**Interfaces:**
- Consumes: Prisma enums from Task 2.
- Produces:
  - `parseProfession(raw: string): Profession | null`
  - `PROFESSION_LABELS: Record<Profession, string>`
  - `clinicWallTimeToUtc(date: string, time: string): Date` — `date` is `yyyy-mm-dd`, `time` is `HH:MM`, both clinic-local
  - `overlaps(a: Interval, b: Interval): boolean` where `Interval = { startsAt: Date; endsAt: Date }`
  - `durationMinutes(a: Interval): number`
  - `isoWeekOf(d: Date): string` — e.g. `"2026-W33"`
  - `weekBounds(isoWeek: string): { start: Date; end: Date }`
  - `createAppError(code, message, meta?)` and the `RuleCode` union

- [ ] **Step 1: Write the profession test**

Create `tests/domain/profession.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseProfession } from '@/lib/domain/profession'

describe('parseProfession', () => {
  it.each([
    ['NURSE', 'NURSE'], ['nurse', 'NURSE'], ['RN', 'NURSE'],
    ['Registered Nurse', 'NURSE'], ['  Nurse  ', 'NURSE'],
    ['Doctor', 'DOCTOR'], ['DOCTOR ', 'DOCTOR'], ['MD', 'DOCTOR'], ['Physician', 'DOCTOR'],
    ['receptionist', 'RECEPTIONIST'], ['Reception', 'RECEPTIONIST'],
    ['recep.', 'RECEPTIONIST'], ['Receptionist', 'RECEPTIONIST'],
  ])('maps %j to %s', (raw, expected) => {
    expect(parseProfession(raw)).toBe(expected)
  })

  it.each([['Janitor'], [''], ['   '], ['Surgeon']])('rejects %j', (raw) => {
    expect(parseProfession(raw)).toBeNull()
  })
})
```

- [ ] **Step 2: Write the time test**

Create `tests/domain/time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clinicWallTimeToUtc, durationMinutes, isoWeekOf, overlaps, weekBounds } from '@/lib/domain/time'

describe('clinicWallTimeToUtc', () => {
  it('applies British Summer Time in August', () => {
    // 08:00 Europe/London in August is BST (UTC+1)
    expect(clinicWallTimeToUtc('2026-08-12', '08:00').toISOString()).toBe('2026-08-12T07:00:00.000Z')
  })

  it('applies GMT in January', () => {
    expect(clinicWallTimeToUtc('2026-01-12', '08:00').toISOString()).toBe('2026-01-12T08:00:00.000Z')
  })
})

describe('overlaps', () => {
  const iv = (s: string, e: string) => ({ startsAt: new Date(s), endsAt: new Date(e) })

  it('detects a partial overlap', () => {
    expect(overlaps(iv('2026-08-12T07:00Z', '2026-08-12T15:00Z'),
                    iv('2026-08-12T14:00Z', '2026-08-12T22:00Z'))).toBe(true)
  })

  it('treats touching intervals as non-overlapping (half-open)', () => {
    expect(overlaps(iv('2026-08-12T07:00Z', '2026-08-12T15:00Z'),
                    iv('2026-08-12T15:00Z', '2026-08-12T23:00Z'))).toBe(false)
  })

  it('detects an overnight shift overlapping the next morning', () => {
    expect(overlaps(iv('2026-08-12T21:00Z', '2026-08-13T05:00Z'),
                    iv('2026-08-13T04:00Z', '2026-08-13T12:00Z'))).toBe(true)
  })
})

describe('durationMinutes', () => {
  it('measures an overnight shift as 8 hours', () => {
    expect(durationMinutes({ startsAt: new Date('2026-08-12T21:00Z'),
                             endsAt:   new Date('2026-08-13T05:00Z') })).toBe(480)
  })
})

describe('isoWeekOf / weekBounds', () => {
  it('places 2026-08-12 in ISO week 33', () => {
    expect(isoWeekOf(new Date('2026-08-12T07:00Z'))).toBe('2026-W33')
  })

  it('round-trips a week to a Monday-start 7-day window', () => {
    const { start, end } = weekBounds('2026-W33')
    expect(isoWeekOf(start)).toBe('2026-W33')
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(7)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- tests/domain`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `profession.ts`**

Create `lib/domain/profession.ts`:

```ts
import type { Profession } from '@prisma/client'

/** Every spelling seen in the clinic's exports, plus the canonical forms. §5.2 */
const ALIASES: Record<string, Profession> = {
  nurse: 'NURSE', nurses: 'NURSE', rn: 'NURSE', 'registered nurse': 'NURSE',
  doctor: 'DOCTOR', doctors: 'DOCTOR', md: 'DOCTOR', physician: 'DOCTOR',
  receptionist: 'RECEPTIONIST', receptionists: 'RECEPTIONIST',
  reception: 'RECEPTIONIST', recep: 'RECEPTIONIST',
}

/** Lower-cases, collapses whitespace and strips a trailing period ("recep." -> "recep"). */
function canonicalise(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '')
}

export function parseProfession(raw: string): Profession | null {
  return ALIASES[canonicalise(raw)] ?? null
}

export const PROFESSION_LABELS: Record<Profession, string> = {
  DOCTOR: 'Doctor',
  NURSE: 'Nurse',
  RECEPTIONIST: 'Receptionist',
}

export const PROFESSIONS: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']
```

- [ ] **Step 5: Implement `time.ts`**

Create `lib/domain/time.ts`:

```ts
export interface Interval { startsAt: Date; endsAt: Date }

const CLINIC_TZ = process.env.CLINIC_TZ ?? 'Europe/London'

/**
 * Offset in minutes that the clinic timezone is ahead of UTC at the given instant.
 * Derived by formatting the instant in the clinic zone and diffing against UTC —
 * this is DST-correct without pulling in a date library.
 */
function tzOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  )
  return (asUtc - at.getTime()) / 60_000
}

/**
 * Converts a clinic-local wall-clock date+time to the UTC instant it denotes.
 * `date` is "yyyy-mm-dd", `time` is "HH:MM", both as written on the roster.
 */
export function clinicWallTimeToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!)
  // Two passes: the offset itself depends on the instant, which we only know approximately.
  let guess = new Date(naive - tzOffsetMinutes(new Date(naive)) * 60_000)
  guess = new Date(naive - tzOffsetMinutes(guess) * 60_000)
  return guess
}

/** Half-open [start, end) overlap: shifts that merely touch do not conflict. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt
}

export function durationMinutes(a: Interval): number {
  return (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000
}

/** ISO-8601 week, e.g. "2026-W33". Weeks start Monday; week 1 contains the first Thursday. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = t.getUTCDay() || 7          // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)  // move to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Monday 00:00 (clinic-local) through the following Monday 00:00, as UTC instants. */
export function weekBounds(isoWeek: string): { start: Date; end: Date } {
  const [yearStr, weekStr] = isoWeek.split('-W')
  const year = Number(yearStr)
  const week = Number(weekStr)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1)
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7)

  const iso = (x: Date) => x.toISOString().slice(0, 10)
  const start = clinicWallTimeToUtc(iso(monday), '00:00')
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 7)
  const end = clinicWallTimeToUtc(iso(sunday), '00:00')
  return { start, end }
}
```

- [ ] **Step 6: Implement `errors.ts`**

Create `lib/domain/errors.ts`:

```ts
export const RULE_CODES = [
  'SHIFT_IN_PAST',
  'PROFESSION_NOT_REQUIRED',
  'ROLE_FULL',
  'OVERLAP',
  'ALREADY_CLAIMED',
  'NOT_CLAIMED',
  'VERSION_CONFLICT',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
] as const

export type RuleCode = (typeof RULE_CODES)[number]

export interface AppError {
  readonly code: RuleCode
  readonly message: string
  readonly meta?: Record<string, unknown>
}

/** Factory for the domain error catalog — the one place an AppError is constructed. */
export function createAppError(
  code: RuleCode,
  message: string,
  meta?: Record<string, unknown>,
): AppError {
  return meta === undefined ? { code, message } : { code, message, meta }
}

const HTTP_STATUS: Record<RuleCode, number> = {
  SHIFT_IN_PAST: 409, PROFESSION_NOT_REQUIRED: 409, ROLE_FULL: 409,
  OVERLAP: 409, ALREADY_CLAIMED: 409, NOT_CLAIMED: 409,
  VERSION_CONFLICT: 409, FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400,
}

export const statusFor = (code: RuleCode): number => HTTP_STATUS[code]
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/domain`
Expected: PASS — 20 profession cases, 8 time cases.

- [ ] **Step 8: Commit**

```bash
git add lib/domain tests/domain
git commit -m "feat: add profession aliases, clinic-timezone conversion and error catalog

Wall-clock conversion is DST-correct via Intl offset probing, so August BST
shifts and January GMT shifts both land on the right UTC instant. Overlap is
half-open so back-to-back shifts do not conflict.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Import core — issues, outcome derivation, rule registry

**Files:**
- Create: `lib/import/issues.ts`, `lib/import/registry.ts`, `lib/import/csv.ts`
- Test: `tests/import/issues.test.ts`, `tests/import/csv.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Severity = 'REPAIR' | 'FATAL'`
  - `interface Issue { code: string; severity: Severity; field?: string; message: string; before?: string; after?: string }`
  - `createIssue(code, severity, message, opts?): Issue`
  - `deriveOutcome(issues: Issue[], merged: boolean): RowOutcome`
  - `createFieldRule<In, Out>(spec): FieldRule<In, Out>` and `applyFieldRules`
  - `splitCsv(text: string): { header: string[]; rows: RawRow[] }` where `RawRow = { rowNumber: number; raw: string; cells: string[] }`

- [ ] **Step 1: Write the issues test**

Create `tests/import/issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createIssue, deriveOutcome } from '@/lib/import/issues'

const repair = () => createIssue('WHITESPACE', 'REPAIR', 'Trimmed whitespace')
const fatal  = () => createIssue('BLANK_NAME', 'FATAL', 'Name is empty')

describe('deriveOutcome', () => {
  it('is ACCEPTED when nothing happened', () => {
    expect(deriveOutcome([], false)).toBe('ACCEPTED')
  })

  it('is REPAIRED when only repairs happened', () => {
    expect(deriveOutcome([repair()], false)).toBe('REPAIRED')
  })

  it('is REJECTED when any issue is fatal, even alongside repairs', () => {
    expect(deriveOutcome([repair(), fatal()], false)).toBe('REJECTED')
  })

  it('lets a fatal issue beat a merge', () => {
    expect(deriveOutcome([fatal()], true)).toBe('REJECTED')
  })

  it('is MERGED when the row folded into another and nothing was fatal', () => {
    expect(deriveOutcome([repair()], true)).toBe('MERGED')
  })
})
```

- [ ] **Step 2: Write the CSV splitter test**

Create `tests/import/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { splitCsv } from '@/lib/import/csv'

describe('splitCsv', () => {
  it('reports 1-based row numbers that match the file (header is line 1)', () => {
    const { rows } = splitCsv('a,b\n1,2\n3,4\n')
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3])
  })

  it('preserves the raw line verbatim for the import report', () => {
    const { rows } = splitCsv('a,b\n  x , y \n')
    expect(rows[0]!.raw).toBe('  x , y ')
    expect(rows[0]!.cells).toEqual(['  x ', ' y '])
  })

  it('handles quoted cells containing commas', () => {
    const { rows } = splitCsv('a,b\n"Doe, Jane",nurse\n')
    expect(rows[0]!.cells).toEqual(['Doe, Jane', 'nurse'])
  })

  it('skips blank lines and tolerates CRLF', () => {
    const { rows } = splitCsv('a,b\r\n1,2\r\n\r\n3,4\r\n')
    expect(rows).toHaveLength(2)
  })

  it('does not pad or truncate short rows — arity is the caller\'s problem', () => {
    const { rows } = splitCsv('a,b,c\n1,2\n')
    expect(rows[0]!.cells).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- tests/import`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `issues.ts`**

Create `lib/import/issues.ts`:

```ts
import type { RowOutcome } from '@prisma/client'

export type Severity = 'REPAIR' | 'FATAL'

export interface Issue {
  code: string
  severity: Severity
  message: string
  field?: string
  before?: string
  after?: string
}

/** Sole constructor for issues, so every logged decision has the same shape. */
export function createIssue(
  code: string,
  severity: Severity,
  message: string,
  opts: { field?: string; before?: string; after?: string } = {},
): Issue {
  return { code, severity, message, ...opts }
}

/**
 * Outcome is derived from what happened, never assigned by hand (§5.1).
 * Precedence: any FATAL wins, then a merge, then a repair, else clean.
 */
export function deriveOutcome(issues: Issue[], merged: boolean): RowOutcome {
  if (issues.some((i) => i.severity === 'FATAL')) return 'REJECTED'
  if (merged) return 'MERGED'
  if (issues.length > 0) return 'REPAIRED'
  return 'ACCEPTED'
}
```

- [ ] **Step 5: Implement `csv.ts`**

Create `lib/import/csv.ts`:

```ts
export interface RawRow {
  rowNumber: number   // 1-based line number in the source file
  raw: string         // the untouched line, shown verbatim in the import report
  cells: string[]     // split but NOT trimmed — normalisation is a later stage
}

/** Splits one CSV line, honouring double-quoted cells and "" escapes. */
function splitLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { cells.push(cur); cur = '' }
    else cur += ch
  }
  cells.push(cur)
  return cells
}

export function splitCsv(text: string): { header: string[]; rows: RawRow[] } {
  const lines = text.split(/\r?\n/)
  const header = splitLine(lines[0] ?? '').map((h) => h.trim())
  const rows: RawRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    rows.push({ rowNumber: i + 1, raw: line, cells: splitLine(line) })
  }
  return { header, rows }
}
```

- [ ] **Step 6: Implement `registry.ts`**

Create `lib/import/registry.ts`:

```ts
import { createIssue, type Issue, type Severity } from './issues'

export interface RuleContext { push(issue: Issue): void }

export interface FieldRule<In, Out> {
  /** Stable identifier, also used as the issue code and as the test-case name. */
  code: string
  /** Human sentence for the import report legend. */
  describe: string
  /** Returns the coerced value, or null to reject the row. */
  run(input: In, ctx: RuleContext): Out | null
}

/**
 * Factory for a field rule. Rules are declared once here and reused by the
 * pipeline, the generated test suite and the import-report legend (§5.1),
 * so a rule can never exist in one of those three places but not the others.
 */
export function createFieldRule<In, Out>(spec: FieldRule<In, Out>): FieldRule<In, Out> {
  return spec
}

/** Convenience for rules that repair a value in place and log the before/after. */
export function repairing<T>(
  ctx: RuleContext,
  code: string,
  field: string,
  message: string,
  before: T,
  after: T,
): T {
  if (String(before) !== String(after)) {
    ctx.push(createIssue(code, 'REPAIR', message, {
      field, before: String(before), after: String(after),
    }))
  }
  return after
}

/** Convenience for rules that kill the row. */
export function fatal(ctx: RuleContext, code: string, field: string, message: string, before?: string): null {
  ctx.push(createIssue(code, 'FATAL', message, before === undefined ? { field } : { field, before }))
  return null
}

/** Collects issues for one row. */
export function createRuleContext(): RuleContext & { issues: Issue[] } {
  const issues: Issue[] = []
  return { issues, push: (i) => { issues.push(i) } }
}

export type { Severity }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/import`
Expected: PASS — 5 outcome cases, 5 CSV cases.

- [ ] **Step 8: Commit**

```bash
git add lib/import tests/import
git commit -m "feat: add import issue model, outcome derivation and rule registry

Outcome is derived from the issues a row accumulated rather than assigned,
so REJECTED always beats MERGED and a row can never be reported as clean
while carrying a fatal issue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Import — staff pipeline

**Files:**
- Create: `lib/import/staff.ts`
- Test: `tests/import/staff.test.ts`

**Interfaces:**
- Consumes: `splitCsv`, `createRuleContext`, `repairing`, `fatal`, `deriveOutcome` (Task 4); `parseProfession` (Task 3).
- Produces:
  - `interface StaffRecord { externalId: number; name: string; email: string; profession: Profession }`
  - `interface StaffRow { rowNumber: number; raw: string; record: StaffRecord | null; issues: Issue[] }`
  - `parseStaffRows(text: string): StaffRow[]` — normalise/coerce/validate only. Deduplication happens in Task 6.

- [ ] **Step 1: Write the staff pipeline test**

Create `tests/import/staff.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseStaffRows } from '@/lib/import/staff'

const HEADER = 'staff_id,full_name,role,email\n'
const one = (line: string) => parseStaffRows(HEADER + line + '\n')[0]!
const codes = (line: string) => one(line).issues.map((i) => i.code).sort()

describe('parseStaffRows — accepted', () => {
  it('accepts a clean row with no issues', () => {
    const r = one('121,Marcus Whitfield,Doctor,marcus.whitfield@clinicmail.test')
    expect(r.issues).toEqual([])
    expect(r.record).toEqual({
      externalId: 121, name: 'Marcus Whitfield',
      email: 'marcus.whitfield@clinicmail.test', profession: 'DOCTOR',
    })
  })
})

describe('parseStaffRows — repairs', () => {
  it('normalises every role alias to the enum', () => {
    expect(one('113,Tara Rahman,Registered Nurse,t@c.test').record!.profession).toBe('NURSE')
    expect(one('118,Omar Patel,MD,o@c.test').record!.profession).toBe('DOCTOR')
    expect(one('102,Hiro Petrova,recep.,h@c.test').record!.profession).toBe('RECEPTIONIST')
  })

  it('repairs an (at) email into a real address', () => {
    const r = one('122,Priya Weber,Doctor,priya.weber(at)clinicmail.test')
    expect(r.record!.email).toBe('priya.weber@clinicmail.test')
    expect(codes('122,Priya Weber,Doctor,priya.weber(at)clinicmail.test')).toContain('EMAIL_AT_LITERAL')
  })

  it('trims whitespace without re-casing the name', () => {
    const r = one('133,  Karan ALI,Reception,karan.ali@clinicmail.test')
    expect(r.record!.name).toBe('Karan ALI')   // ALI is preserved — §5.4
  })

  it('trims a padded role value', () => {
    expect(one('101,Ben Ali, Nurse ,ben.ali@clinicmail.test').record!.profession).toBe('NURSE')
  })

  it('lower-cases the email so collisions are detectable', () => {
    expect(one('140,Sam Roe,Nurse,Sam.Roe@Clinicmail.TEST').record!.email).toBe('sam.roe@clinicmail.test')
  })
})

describe('parseStaffRows — rejections', () => {
  it('rejects an unknown profession', () => {
    const r = one('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
    expect(r.record).toBeNull()
    expect(codes('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')).toContain('UNKNOWN_PROFESSION')
  })

  it('rejects a blank name', () => {
    expect(one('996,,Doctor,noname@clinicmail.test').record).toBeNull()
    expect(codes('996,,Doctor,noname@clinicmail.test')).toContain('BLANK_NAME')
  })

  it('rejects a blank email because email is the login identity', () => {
    expect(one('995,Robin Vale,Nurse,').record).toBeNull()
    expect(codes('995,Robin Vale,Nurse,')).toContain('BLANK_EMAIL')
  })

  it('rejects an email that is still malformed after repair', () => {
    expect(one('140,Sam Roe,Nurse,not-an-email').record).toBeNull()
    expect(codes('140,Sam Roe,Nurse,not-an-email')).toContain('INVALID_EMAIL')
  })

  it('rejects a non-numeric staff id', () => {
    expect(one('abc,Sam Roe,Nurse,sam@c.test').record).toBeNull()
    expect(codes('abc,Sam Roe,Nurse,sam@c.test')).toContain('INVALID_ID')
  })

  it('rejects a row with the wrong number of columns', () => {
    expect(one('140,Sam Roe,Nurse').record).toBeNull()
    expect(codes('140,Sam Roe,Nurse')).toContain('BAD_ARITY')
  })
})

describe('parseStaffRows — reporting', () => {
  it('keeps the raw line and file line number for the report', () => {
    const r = one('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
    expect(r.rowNumber).toBe(2)
    expect(r.raw).toBe('997,Casey Morgan,Janitor,casey.morgan@clinicmail.test')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/import/staff.test.ts`
Expected: FAIL — `@/lib/import/staff` not found.

- [ ] **Step 3: Implement `staff.ts`**

Create `lib/import/staff.ts`:

```ts
import type { Profession } from '@prisma/client'
import { parseProfession } from '@/lib/domain/profession'
import { splitCsv } from './csv'
import type { Issue } from './issues'
import { createRuleContext, fatal, repairing, type RuleContext } from './registry'

export interface StaffRecord {
  externalId: number
  name: string
  email: string
  profession: Profession
}

export interface StaffRow {
  rowNumber: number
  raw: string
  record: StaffRecord | null
  issues: Issue[]
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function coerceId(cell: string, ctx: RuleContext): number | null {
  const trimmed = cell.trim()
  if (!/^\d+$/.test(trimmed)) {
    return fatal(ctx, 'INVALID_ID', 'staff_id', 'Staff id is not a whole number.', cell)
  }
  return Number(trimmed)
}

function coerceName(cell: string, ctx: RuleContext): string | null {
  // Whitespace only. Casing is never touched — "ALI", "McDonald", "van der Berg". §5.4
  const cleaned = cell.trim().replace(/\s+/g, ' ')
  if (cleaned === '') {
    return fatal(ctx, 'BLANK_NAME', 'full_name', 'Name is empty; cannot create a staff member.', cell)
  }
  return repairing(ctx, 'NAME_WHITESPACE', 'full_name', 'Trimmed surrounding whitespace.', cell, cleaned)
}

function coerceEmail(cell: string, ctx: RuleContext): string | null {
  const trimmed = cell.trim()
  if (trimmed === '') {
    return fatal(ctx, 'BLANK_EMAIL', 'email',
      'Email is empty; it is the login identity so the row cannot be imported.', cell)
  }

  let value = trimmed
  if (value.includes('(at)')) {
    value = repairing(ctx, 'EMAIL_AT_LITERAL', 'email',
      'Replaced the literal "(at)" with "@".', value, value.replace('(at)', '@'))
  }
  value = repairing(ctx, 'EMAIL_CASE', 'email',
    'Lower-cased the address so duplicates are detectable.', value, value.toLowerCase())

  if (!EMAIL_SHAPE.test(value)) {
    return fatal(ctx, 'INVALID_EMAIL', 'email', 'Not a valid email address.', cell)
  }
  return value
}

function coerceProfession(cell: string, ctx: RuleContext): Profession | null {
  const parsed = parseProfession(cell)
  if (parsed === null) {
    return fatal(ctx, 'UNKNOWN_PROFESSION', 'role',
      `"${cell.trim()}" is not a profession this clinic schedules.`, cell)
  }
  return repairing(ctx, 'ROLE_ALIAS', 'role',
    'Normalised the role spelling.', cell.trim(), parsed) as Profession
}

export function parseStaffRows(text: string): StaffRow[] {
  return splitCsv(text).rows.map(({ rowNumber, raw, cells }) => {
    const ctx = createRuleContext()

    if (cells.length !== 4) {
      ctx.push({
        code: 'BAD_ARITY', severity: 'FATAL',
        message: `Expected 4 columns, found ${cells.length}.`, before: raw,
      })
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const externalId = coerceId(cells[0]!, ctx)
    const name       = coerceName(cells[1]!, ctx)
    const profession = coerceProfession(cells[2]!, ctx)
    const email      = coerceEmail(cells[3]!, ctx)

    const record =
      externalId !== null && name !== null && profession !== null && email !== null
        ? { externalId, name, email, profession }
        : null

    return { rowNumber, raw, record, issues: ctx.issues }
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/import/staff.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Sanity-check against the real file**

Run:

```bash
npx tsx -e "
import { parseStaffRows } from './lib/import/staff'
import { readFileSync } from 'node:fs'
const rows = parseStaffRows(readFileSync('staff.csv', 'utf8'))
console.log('rows', rows.length, 'rejected', rows.filter(r => !r.record).length)
console.log(rows.filter(r => !r.record).map(r => r.raw))
"
```

Expected: `rows 41 rejected 3` and the three lines are staff `995`, `996`, `997`.
Staff `998` is **not** rejected here — its defect is an email collision, which is a
reconciliation concern handled in Task 6.

- [ ] **Step 6: Commit**

```bash
git add lib/import/staff.ts tests/import/staff.test.ts
git commit -m "feat: add staff CSV parsing, normalisation and validation

Repairs role aliases, (at) emails and whitespace; rejects unknown
professions, blank names and blank emails. Personal-name casing is
deliberately preserved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Import — shifts pipeline

**Files:**
- Create: `lib/import/shifts.ts`
- Test: `tests/import/shifts.test.ts`

**Interfaces:**
- Consumes: `splitCsv`, `createRuleContext`, `repairing`, `fatal` (Task 4); `clinicWallTimeToUtc`, `durationMinutes` (Task 3); `parseProfession` (Task 3).
- Produces:
  - `interface ShiftRecord { externalId: number; startsAt: Date; endsAt: Date; requirements: Record<Profession, number> }`
  - `interface ShiftRow { rowNumber: number; raw: string; record: ShiftRecord | null; issues: Issue[] }`
  - `parseShiftRows(text: string): ShiftRow[]`
  - `MAX_SHIFT_MINUTES = 720`

- [ ] **Step 1: Write the shifts pipeline test**

Create `tests/import/shifts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseShiftRows } from '@/lib/import/shifts'

const HEADER = 'shift_id,date,start_time,end_time,requirements\n'
const one = (line: string) => parseShiftRows(HEADER + line + '\n')[0]!
const codes = (line: string) => one(line).issues.map((i) => i.code)

describe('parseShiftRows — dates', () => {
  it('accepts an ISO date unchanged', () => {
    const r = one('5053,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1')
    expect(r.record!.startsAt.toISOString()).toBe('2026-08-17T07:00:00.000Z') // BST
    expect(r.issues).toEqual([])
  })

  it('reads a slash date as dd/mm/yyyy', () => {
    // 20/08/2026 is 20 August, not an invalid month 20
    const r = one('5065,20/08/2026,08:00,16:00,nurses=2;doctors=1;receptionists=0')
    expect(r.record!.startsAt.toISOString().slice(0, 10)).toBe('2026-08-20')
    expect(codes('5065,20/08/2026,08:00,16:00,nurses=2;doctors=1;receptionists=0')).toContain('DATE_FORMAT')
  })

  it('reads a dash date as mm-dd-yyyy', () => {
    // 08-13-2026 is 13 August — the second field exceeds 12 so it must be the day
    const r = one('5041,08-13-2026,16:00,00:00,nurses=3;doctors=2;receptionists=0')
    expect(r.record!.startsAt.toISOString().slice(0, 10)).toBe('2026-08-13')
  })

  it('rejects a date that does not exist', () => {
    expect(one('5110,2026-02-30,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5110,2026-02-30,08:00,16:00,nurses=1')).toContain('IMPOSSIBLE_DATE')
  })

  it('rejects a slash date where neither field can be the month', () => {
    expect(one('5200,13/14/2026,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5200,13/14/2026,08:00,16:00,nurses=1')).toContain('AMBIGUOUS_DATE')
  })

  it('rejects an unrecognised date shape', () => {
    expect(one('5201,August 5th,08:00,16:00,nurses=1').record).toBeNull()
    expect(codes('5201,August 5th,08:00,16:00,nurses=1')).toContain('UNPARSEABLE_DATE')
  })
})

describe('parseShiftRows — times', () => {
  it('rolls an overnight shift forward a day and keeps it at 8 hours', () => {
    const r = one('5050,2026-08-16,22:00,06:00,nurses=2;doctors=1;receptionists=1')
    expect(r.record!.endsAt.getTime() - r.record!.startsAt.getTime()).toBe(8 * 3_600_000)
    expect(codes('5050,2026-08-16,22:00,06:00,nurses=2;doctors=1;receptionists=1')).toContain('OVERNIGHT_ROLLOVER')
  })

  it('treats a 00:00 end as midnight the next day', () => {
    const r = one('5097,2026-08-28,16:00,00:00,nurses=3;doctors=1;receptionists=0')
    expect(r.record!.endsAt.getTime() - r.record!.startsAt.getTime()).toBe(8 * 3_600_000)
  })

  it('rejects an 18-hour shift', () => {
    expect(one('5109,2026-08-12,15:00,09:00,nurses=2;doctors=1').record).toBeNull()
    expect(codes('5109,2026-08-12,15:00,09:00,nurses=2;doctors=1')).toContain('DURATION_TOO_LONG')
  })

  it('rejects a zero-length shift', () => {
    expect(one('5112,2026-08-15,12:00,12:00,doctors=1').record).toBeNull()
    expect(codes('5112,2026-08-15,12:00,12:00,doctors=1')).toContain('DURATION_TOO_LONG')
  })

  it('rejects an explicit +1 that yields 26 hours', () => {
    expect(one('5115,2026-08-21,08:00,10:00+1,nurses=2').record).toBeNull()
    expect(codes('5115,2026-08-21,08:00,10:00+1,nurses=2')).toContain('DURATION_TOO_LONG')
  })

  it('rejects a missing start time', () => {
    expect(one('5114,2026-08-20,,16:00,nurses=1;doctors=1').record).toBeNull()
    expect(codes('5114,2026-08-20,,16:00,nurses=1;doctors=1')).toContain('MISSING_TIME')
  })
})

describe('parseShiftRows — requirements', () => {
  it('defaults omitted role keys to zero', () => {
    const r = one('5111,09/08/2026,10:00,18:00,nurses=2')
    expect(r.record!.requirements).toEqual({ DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 })
    expect(codes('5111,09/08/2026,10:00,18:00,nurses=2')).toContain('REQUIREMENT_DEFAULTED')
  })

  it('rejects free-text requirements rather than guessing', () => {
    expect(one('5113,2026-08-18,08:00,16:00,two nurses and a doctor').record).toBeNull()
    expect(codes('5113,2026-08-18,08:00,16:00,two nurses and a doctor')).toContain('UNPARSEABLE_REQUIREMENTS')
  })

  it('rejects a shift that needs nobody', () => {
    expect(one('5202,2026-08-18,08:00,16:00,nurses=0;doctors=0;receptionists=0').record).toBeNull()
    expect(codes('5202,2026-08-18,08:00,16:00,nurses=0;doctors=0;receptionists=0')).toContain('ZERO_HEADCOUNT')
  })

  it('rejects an unknown requirement key', () => {
    expect(one('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1').record).toBeNull()
    expect(codes('5203,2026-08-18,08:00,16:00,janitors=1;nurses=1')).toContain('UNKNOWN_REQUIREMENT_KEY')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/import/shifts.test.ts`
Expected: FAIL — `@/lib/import/shifts` not found.

- [ ] **Step 3: Implement `shifts.ts`**

Create `lib/import/shifts.ts`:

```ts
import type { Profession } from '@prisma/client'
import { clinicWallTimeToUtc, durationMinutes } from '@/lib/domain/time'
import { parseProfession } from '@/lib/domain/profession'
import { splitCsv } from './csv'
import type { Issue } from './issues'
import { createRuleContext, fatal, repairing, type RuleContext } from './registry'

export const MAX_SHIFT_MINUTES = 720 // 12h — see §5.3

export interface ShiftRecord {
  externalId: number
  startsAt: Date
  endsAt: Date
  requirements: Record<Profession, number>
}

export interface ShiftRow {
  rowNumber: number
  raw: string
  record: ShiftRecord | null
  issues: Issue[]
}

const ISO   = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/  // dd/mm/yyyy — see §2.2
const DASH  = /^(\d{1,2})-(\d{1,2})-(\d{4})$/    // mm-dd-yyyy — see §2.2
const TIME  = /^(\d{1,2}):(\d{2})(\+1)?$/

/** True only if the y-m-d triple is a real calendar date. */
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Decodes the three date shapes present in the export. The slash/dash readings
 * are not guesses: across the corpus the slash form's first field reaches 30 and
 * the dash form's second field reaches 27, and both readings agree with the
 * monotonic shift_id ordering. See §2.2.
 */
function coerceDate(cell: string, ctx: RuleContext): string | null {
  const raw = cell.trim()
  if (raw === '') return fatal(ctx, 'MISSING_DATE', 'date', 'Date is empty.', cell)

  let y: number, m: number, d: number, code: string | null

  const iso = ISO.exec(raw)
  const slash = SLASH.exec(raw)
  const dash = DASH.exec(raw)

  if (iso) {
    ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    code = null
  } else if (slash) {
    ;[d, m, y] = [Number(slash[1]), Number(slash[2]), Number(slash[3])]
    if (d > 12 && m > 12) return fatal(ctx, 'AMBIGUOUS_DATE', 'date',
      'Neither field can be a month, so the date cannot be resolved.', cell)
    code = 'DATE_FORMAT'
  } else if (dash) {
    ;[m, d, y] = [Number(dash[1]), Number(dash[2]), Number(dash[3])]
    if (d > 12 && m > 12) return fatal(ctx, 'AMBIGUOUS_DATE', 'date',
      'Neither field can be a month, so the date cannot be resolved.', cell)
    code = 'DATE_FORMAT'
  } else {
    return fatal(ctx, 'UNPARSEABLE_DATE', 'date', 'Date is not in a recognised format.', cell)
  }

  if (!isRealDate(y, m, d)) {
    return fatal(ctx, 'IMPOSSIBLE_DATE', 'date', 'That calendar date does not exist.', cell)
  }

  const isoDate = `${y}-${pad(m)}-${pad(d)}`
  if (code !== null) {
    repairing(ctx, code, 'date', 'Converted the date to ISO format.', raw, isoDate)
  }
  return isoDate
}

interface ParsedTime { hh: number; mm: number; plusDay: boolean }

function coerceTime(cell: string, field: string, ctx: RuleContext): ParsedTime | null {
  const raw = cell.trim()
  if (raw === '') return fatal(ctx, 'MISSING_TIME', field, `${field} is empty.`, cell)

  const m = TIME.exec(raw)
  if (!m) return fatal(ctx, 'BAD_TIME_FORMAT', field, 'Time is not in HH:MM format.', cell)

  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) {
    return fatal(ctx, 'BAD_TIME_FORMAT', field, 'Time is outside 00:00–23:59.', cell)
  }
  return { hh, mm, plusDay: m[3] === '+1' }
}

function nextDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d! + 1))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

const REQUIREMENT_PAIR = /^([a-z_]+)=(\d+)$/

function coerceRequirements(cell: string, ctx: RuleContext): Record<Profession, number> | null {
  const raw = cell.trim()
  const out: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  const seen = new Set<Profession>()

  if (raw === '') {
    return fatal(ctx, 'UNPARSEABLE_REQUIREMENTS', 'requirements', 'Requirements are empty.', cell)
  }

  for (const part of raw.split(';')) {
    const m = REQUIREMENT_PAIR.exec(part.trim().toLowerCase())
    if (!m) {
      return fatal(ctx, 'UNPARSEABLE_REQUIREMENTS', 'requirements',
        'Requirements are not in "role=count" form; refusing to guess the intent.', cell)
    }
    const profession = parseProfession(m[1]!)
    if (profession === null) {
      return fatal(ctx, 'UNKNOWN_REQUIREMENT_KEY', 'requirements',
        `"${m[1]}" is not a profession this clinic schedules.`, cell)
    }
    out[profession] = Number(m[2])
    seen.add(profession)
  }

  const missing = (['DOCTOR', 'NURSE', 'RECEPTIONIST'] as Profession[]).filter((p) => !seen.has(p))
  if (missing.length > 0) {
    repairing(ctx, 'REQUIREMENT_DEFAULTED', 'requirements',
      `No count given for ${missing.join(', ').toLowerCase()}; defaulted to 0.`,
      raw, JSON.stringify(out))
  }

  if (out.DOCTOR + out.NURSE + out.RECEPTIONIST === 0) {
    return fatal(ctx, 'ZERO_HEADCOUNT', 'requirements',
      'Shift requires nobody, so it is not a shift.', cell)
  }
  return out
}

export function parseShiftRows(text: string): ShiftRow[] {
  return splitCsv(text).rows.map(({ rowNumber, raw, cells }) => {
    const ctx = createRuleContext()

    if (cells.length !== 5) {
      ctx.push({
        code: 'BAD_ARITY', severity: 'FATAL',
        message: `Expected 5 columns, found ${cells.length}.`, before: raw,
      })
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const idCell = cells[0]!.trim()
    const externalId = /^\d+$/.test(idCell) ? Number(idCell) : null
    if (externalId === null) {
      fatal(ctx, 'INVALID_ID', 'shift_id', 'Shift id is not a whole number.', cells[0]!)
    }

    const date  = coerceDate(cells[1]!, ctx)
    const start = coerceTime(cells[2]!, 'start_time', ctx)
    const end   = coerceTime(cells[3]!, 'end_time', ctx)
    const requirements = coerceRequirements(cells[4]!, ctx)

    if (externalId === null || date === null || start === null || end === null || requirements === null) {
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    const startsAt = clinicWallTimeToUtc(date, `${pad(start.hh)}:${pad(start.mm)}`)

    // An end at or before the start means the shift runs into the next day. A
    // literal "+1" says so explicitly. Both land in the same rollover, then the
    // single duration cap below catches 18h, 24h and 26h rows alike. §5.3
    let endDate = date
    if (end.plusDay) {
      endDate = nextDay(date)
      repairing(ctx, 'EXPLICIT_NEXT_DAY', 'end_time', 'End time carries "+1"; moved to the next day.',
        cells[3]!.trim(), `${endDate} ${pad(end.hh)}:${pad(end.mm)}`)
    } else if (end.hh * 60 + end.mm <= start.hh * 60 + start.mm) {
      endDate = nextDay(date)
      repairing(ctx, 'OVERNIGHT_ROLLOVER', 'end_time',
        'End is at or before the start, so the shift runs overnight; moved the end to the next day.',
        cells[3]!.trim(), `${endDate} ${pad(end.hh)}:${pad(end.mm)}`)
    }

    const endsAt = clinicWallTimeToUtc(endDate, `${pad(end.hh)}:${pad(end.mm)}`)
    const mins = durationMinutes({ startsAt, endsAt })

    if (mins <= 0 || mins > MAX_SHIFT_MINUTES) {
      fatal(ctx, 'DURATION_TOO_LONG', 'end_time',
        `Shift is ${(mins / 60).toFixed(1)}h; the maximum is ${MAX_SHIFT_MINUTES / 60}h.`, raw)
      return { rowNumber, raw, record: null, issues: ctx.issues }
    }

    return {
      rowNumber, raw,
      record: { externalId, startsAt, endsAt, requirements },
      issues: ctx.issues,
    }
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/import/shifts.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Sanity-check against the real file**

Run:

```bash
npx tsx -e "
import { parseShiftRows } from './lib/import/shifts'
import { readFileSync } from 'node:fs'
const rows = parseShiftRows(readFileSync('shifts.csv','utf8'))
console.log('rows', rows.length, 'rejected', rows.filter(r => !r.record).length)
console.log(rows.filter(r => !r.record).map(r => r.raw.split(',')[0]))
"
```

Expected: `rows 117 rejected 6` and the ids are exactly `5109 5110 5112 5113 5114 5115`.

- [ ] **Step 6: Commit**

```bash
git add lib/import/shifts.ts tests/import/shifts.test.ts
git commit -m "feat: add shift CSV parsing with evidence-based date decoding

Slash dates read as dd/mm and dash dates as mm-dd, both established from the
corpus rather than guessed. A single overnight-rollover plus 12h cap rejects
the 18h, 24h and 26h rows while leaving 22:00-06:00 overnights intact.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Import — reconciliation, entry point and golden-file test

**Files:**
- Create: `lib/import/reconcile.ts`, `lib/import/index.ts`
- Test: `tests/import/reconcile.test.ts`, `tests/import/golden.test.ts`

**Interfaces:**
- Consumes: `parseStaffRows` (Task 5), `parseShiftRows` (Task 6), `deriveOutcome` (Task 4).
- Produces:
  - `interface ImportedRow<T> { rowNumber: number; raw: string; outcome: RowOutcome; issues: Issue[]; record: T | null; mergedIntoExternalId?: number }`
  - `interface ImportResult<T> { rows: ImportedRow<T>[]; accepted: T[]; stats: { accepted: number; merged: number; rejected: number; total: number } }`
  - `runStaffImport(text: string): ImportResult<StaffRecord>`
  - `runShiftImport(text: string): ImportResult<ShiftRecord>`

- [ ] **Step 1: Write the reconciliation test**

Create `tests/import/reconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'

const S = 'staff_id,full_name,role,email\n'
const H = 'shift_id,date,start_time,end_time,requirements\n'

describe('staff reconciliation', () => {
  it('merges a byte-identical duplicate row', () => {
    const r = runStaffImport(S +
      '103,Marcus Kapoor,receptionist,marcus.kapoor@clinicmail.test\n' +
      '103,Marcus Kapoor,receptionist,marcus.kapoor@clinicmail.test\n')
    expect(r.stats).toMatchObject({ accepted: 1, merged: 1, rejected: 0, total: 2 })
    expect(r.rows[1]!.outcome).toBe('MERGED')
  })

  it('merges the same person filed under two ids, keeping the lowest', () => {
    const r = runStaffImport(S +
      '999,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n' +
      '105,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.externalId).toBe(105)
    expect(r.rows.find((x) => x.outcome === 'MERGED')!.mergedIntoExternalId).toBe(105)
  })

  it('rejects a second person reusing an existing email', () => {
    const r = runStaffImport(S +
      '107,Hiro Iyer,Receptionist,hiro.iyer@clinicmail.test\n' +
      '998,J. Placeholder,Nurse,hiro.iyer@clinicmail.test\n')
    expect(r.stats).toMatchObject({ accepted: 1, rejected: 1 })
    expect(r.rows[1]!.issues.map((i) => i.code)).toContain('EMAIL_COLLISION')
  })

  it('keeps the first row when one id carries conflicting data', () => {
    const r = runStaffImport(S +
      '150,Ann Lee,Nurse,ann.lee@c.test\n' +
      '150,Ann Lee,Doctor,ann2.lee@c.test\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.profession).toBe('NURSE')
    expect(r.rows[1]!.outcome).toBe('MERGED')
    expect(r.rows[1]!.issues.map((i) => i.code)).toContain('DUPLICATE_ID_CONFLICT')
  })
})

describe('shift reconciliation', () => {
  it('merges a byte-identical duplicate row', () => {
    const r = runShiftImport(H +
      '5020,2026-08-08,22:00,06:00,nurses=1;doctors=0;receptionists=0\n' +
      '5020,2026-08-08,22:00,06:00,nurses=1;doctors=0;receptionists=0\n')
    expect(r.stats).toMatchObject({ accepted: 1, merged: 1, total: 2 })
  })

  it('merges two ids that share date, time AND requirements', () => {
    const r = runShiftImport(H +
      '5053,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1\n' +
      '5054,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.externalId).toBe(5053)
  })

  it('does NOT merge same-slot shifts with different requirements', () => {
    // The 24-group trap from §2.2 — merging these would delete real shifts.
    const r = runShiftImport(H +
      '5003,2026-08-04,08:00,16:00,nurses=3;doctors=2;receptionists=0\n' +
      '5004,2026-08-04,08:00,16:00,nurses=1;doctors=2;receptionists=0\n' +
      '5005,2026-08-04,08:00,16:00,nurses=2;doctors=0;receptionists=0\n')
    expect(r.accepted).toHaveLength(3)
    expect(r.stats.merged).toBe(0)
  })
})
```

- [ ] **Step 2: Write the golden-file test**

Create `tests/import/golden.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'

const rejectedIds = (r: { rows: { outcome: string; raw: string }[] }) =>
  r.rows.filter((x) => x.outcome === 'REJECTED').map((x) => Number(x.raw.split(',')[0])).sort((a, b) => a - b)

const mergedIds = (r: { rows: { outcome: string; raw: string }[] }) =>
  r.rows.filter((x) => x.outcome === 'MERGED').map((x) => Number(x.raw.split(',')[0])).sort((a, b) => a - b)

describe('golden file — staff.csv', () => {
  const result = runStaffImport(readFileSync('staff.csv', 'utf8'))

  it('produces exactly 34 accepted, 3 merged, 4 rejected of 41', () => {
    expect(result.stats).toEqual({ accepted: 34, merged: 3, rejected: 4, total: 41 })
  })

  it('rejects exactly the four known-bad rows', () => {
    expect(rejectedIds(result)).toEqual([995, 996, 997, 998])
  })

  it('merges exactly the three known-duplicate rows', () => {
    expect(mergedIds(result)).toEqual([103, 110, 999])
  })

  it('keeps all 34 real staff ids in 100..133', () => {
    const ids = result.accepted.map((s) => s.externalId).sort((a, b) => a - b)
    expect(ids).toHaveLength(34)
    expect(ids[0]).toBe(100)
    expect(ids.at(-1)).toBe(133)
  })

  it('yields 17 nurses, 8 doctors and 11 receptionists', () => {
    const count = (p: string) => result.accepted.filter((s) => s.profession === p).length
    expect({ NURSE: count('NURSE'), DOCTOR: count('DOCTOR'), RECEPTIONIST: count('RECEPTIONIST') })
      .toEqual({ NURSE: 17, DOCTOR: 8, RECEPTIONIST: 11 })
  })
})

describe('golden file — shifts.csv', () => {
  const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))

  it('produces exactly 109 accepted, 2 merged, 6 rejected of 117', () => {
    expect(result.stats).toEqual({ accepted: 109, merged: 2, rejected: 6, total: 117 })
  })

  it('rejects exactly the six known-bad rows', () => {
    expect(rejectedIds(result)).toEqual([5109, 5110, 5112, 5113, 5114, 5115])
  })

  it('merges the duplicate row and the duplicate id', () => {
    expect(mergedIds(result)).toEqual([5020, 5054])
  })

  it('spans 2026-08-03 to 2026-08-30', () => {
    const days = result.accepted.map((s) => s.startsAt.toISOString().slice(0, 10)).sort()
    expect(days[0]).toBe('2026-08-03')
    expect(days.at(-1)).toBe('2026-08-30')
  })

  it('requires 226 nurse, 115 doctor and 47 receptionist slots in total', () => {
    const sum = (p: 'NURSE' | 'DOCTOR' | 'RECEPTIONIST') =>
      result.accepted.reduce((a, s) => a + s.requirements[p], 0)
    expect({ NURSE: sum('NURSE'), DOCTOR: sum('DOCTOR'), RECEPTIONIST: sum('RECEPTIONIST') })
      .toEqual({ NURSE: 226, DOCTOR: 115, RECEPTIONIST: 47 })
  })

  it('never emits two shifts with the same id', () => {
    const ids = result.accepted.map((s) => s.externalId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- tests/import/reconcile.test.ts tests/import/golden.test.ts`
Expected: FAIL — `@/lib/import` not found.

- [ ] **Step 4: Implement `reconcile.ts`**

Create `lib/import/reconcile.ts`:

```ts
import type { RowOutcome } from '@prisma/client'
import { createIssue, deriveOutcome, type Issue } from './issues'
import type { StaffRecord } from './staff'
import type { ShiftRecord } from './shifts'

export interface ImportedRow<T> {
  rowNumber: number
  raw: string
  outcome: RowOutcome
  issues: Issue[]
  record: T | null
  mergedIntoExternalId?: number
}

export interface ImportResult<T> {
  rows: ImportedRow<T>[]
  accepted: T[]
  stats: { accepted: number; merged: number; rejected: number; total: number }
}

interface ParsedRow<T> { rowNumber: number; raw: string; record: T | null; issues: Issue[] }

/** Identity of a record for "same thing filed twice" detection. */
type KeyFn<T> = (r: T) => string

/**
 * Folds duplicate rows together. `keys` are tried in order; the first that
 * matches an already-accepted record merges the row into it.
 *
 * Where two rows collide, the survivor is the one with the LOWEST external id —
 * so Zainab Volkov filed as both 999 and 105 survives as 105, the in-range id.
 * Because that decision can retroactively replace an already-accepted record,
 * reconciliation runs over rows pre-sorted by external id.
 */
function reconcile<T extends { externalId: number }>(
  parsed: ParsedRow<T>[],
  keys: KeyFn<T>[],
  onCollision: (incoming: T, existing: T, issues: Issue[]) => 'MERGE' | 'REJECT',
): ImportResult<T> {
  const accepted = new Map<number, T>()          // externalId -> record
  const index = new Map<string, number>()        // key -> externalId
  const rows: ImportedRow<T>[] = []

  // Lowest external id wins, so process in id order and let the first arrival stand.
  const order = [...parsed].sort((a, b) => {
    const ai = a.record?.externalId ?? Number.MAX_SAFE_INTEGER
    const bi = b.record?.externalId ?? Number.MAX_SAFE_INTEGER
    return ai - bi || a.rowNumber - b.rowNumber
  })

  for (const row of order) {
    const issues = [...row.issues]

    if (row.record === null) {
      rows.push({ ...row, issues, outcome: deriveOutcome(issues, false), record: null })
      continue
    }

    let hitId: number | undefined
    for (const key of keys) {
      const found = index.get(key(row.record))
      if (found !== undefined) { hitId = found; break }
    }

    if (hitId === undefined) {
      accepted.set(row.record.externalId, row.record)
      for (const key of keys) index.set(key(row.record), row.record.externalId)
      rows.push({ ...row, issues, outcome: deriveOutcome(issues, false) })
      continue
    }

    const existing = accepted.get(hitId)!
    const decision = onCollision(row.record, existing, issues)

    if (decision === 'REJECT') {
      rows.push({ ...row, issues, outcome: deriveOutcome(issues, false), record: null })
    } else {
      rows.push({
        ...row, issues, record: null,
        outcome: deriveOutcome(issues, true),
        mergedIntoExternalId: hitId,
      })
    }
  }

  // Report rows in file order even though reconciliation ran in id order.
  rows.sort((a, b) => a.rowNumber - b.rowNumber)

  const stats = {
    accepted: rows.filter((r) => r.outcome === 'ACCEPTED' || r.outcome === 'REPAIRED').length,
    merged: rows.filter((r) => r.outcome === 'MERGED').length,
    rejected: rows.filter((r) => r.outcome === 'REJECTED').length,
    total: rows.length,
  }

  return { rows, accepted: [...accepted.values()], stats }
}

export function reconcileStaff(parsed: ParsedRow<StaffRecord>[]): ImportResult<StaffRecord> {
  return reconcile<StaffRecord>(
    parsed,
    [
      (r) => `id:${r.externalId}`,
      (r) => `email:${r.email}`,
    ],
    (incoming, existing, issues) => {
      if (incoming.externalId === existing.externalId) {
        const identical =
          incoming.name === existing.name &&
          incoming.email === existing.email &&
          incoming.profession === existing.profession
        issues.push(createIssue(
          identical ? 'DUPLICATE_ROW' : 'DUPLICATE_ID_CONFLICT',
          'REPAIR',
          identical
            ? `Identical to the earlier row for staff ${existing.externalId}; kept one.`
            : `Staff ${existing.externalId} already imported with different details; kept the first row.`,
          { before: JSON.stringify(incoming), after: JSON.stringify(existing) },
        ))
        return 'MERGE'
      }

      // Same email, different id. Same human -> merge. Different human -> reject.
      if (incoming.name === existing.name) {
        issues.push(createIssue('DUPLICATE_PERSON', 'REPAIR',
          `Same person as staff ${existing.externalId}; merged into the lower id.`,
          { before: String(incoming.externalId), after: String(existing.externalId) }))
        return 'MERGE'
      }

      issues.push(createIssue('EMAIL_COLLISION', 'FATAL',
        `Email already belongs to ${existing.name} (staff ${existing.externalId}); ` +
        'emails are login identities and must be unique.',
        { field: 'email', before: incoming.email }))
      return 'REJECT'
    },
  )
}

export function reconcileShifts(parsed: ParsedRow<ShiftRecord>[]): ImportResult<ShiftRecord> {
  // The slot key deliberately INCLUDES requirements. Keying on date+time alone
  // would collapse the 24 legitimate same-slot groups described in §2.2.
  const slotKey = (r: ShiftRecord) =>
    `slot:${r.startsAt.toISOString()}|${r.endsAt.toISOString()}` +
    `|${r.requirements.DOCTOR},${r.requirements.NURSE},${r.requirements.RECEPTIONIST}`

  return reconcile<ShiftRecord>(
    parsed,
    [(r) => `id:${r.externalId}`, slotKey],
    (incoming, existing, issues) => {
      issues.push(createIssue(
        incoming.externalId === existing.externalId ? 'DUPLICATE_ROW' : 'DUPLICATE_SHIFT',
        'REPAIR',
        `Same date, time and requirements as shift ${existing.externalId}; kept the lower id.`,
        { before: String(incoming.externalId), after: String(existing.externalId) },
      ))
      return 'MERGE'
    },
  )
}
```

- [ ] **Step 5: Implement `index.ts`**

Create `lib/import/index.ts`:

```ts
import { parseStaffRows, type StaffRecord } from './staff'
import { parseShiftRows, type ShiftRecord } from './shifts'
import { reconcileShifts, reconcileStaff, type ImportResult } from './reconcile'

export type { ImportResult, ImportedRow } from './reconcile'
export type { StaffRecord } from './staff'
export type { ShiftRecord } from './shifts'

export function runStaffImport(text: string): ImportResult<StaffRecord> {
  return reconcileStaff(parseStaffRows(text))
}

export function runShiftImport(text: string): ImportResult<ShiftRecord> {
  return reconcileShifts(parseShiftRows(text))
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/import`
Expected: PASS. The golden test asserts `{ accepted: 34, merged: 3, rejected: 4, total: 41 }` and `{ accepted: 109, merged: 2, rejected: 6, total: 117 }`.

**If the counts differ, do not adjust the test.** The expected values come from a full profile of the source files (spec §2 and §5.5); a mismatch means a rule is wrong. Diff the actual rejected/merged id lists against the ones in this plan's "Expected Import Result" table to find which rule misfired.

- [ ] **Step 7: Commit**

```bash
git add lib/import tests/import
git commit -m "feat: add import reconciliation and golden-file regression test

Lowest external id wins on a merge, so Zainab Volkov survives as 105 rather
than 999. The shift merge key includes requirements, so the 24 same-slot
groups are preserved rather than collapsed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Import persistence — `applyImport`

**Files:**
- Create: `lib/import/apply.ts`, `tests/helpers/db.ts`
- Test: `tests/import/apply.test.ts`

**Interfaces:**
- Consumes: `ImportResult`, `StaffRecord`, `ShiftRecord` (Task 7); `prisma` (Task 2).
- Produces:
  - `applyStaffImport(tx, result, meta): Promise<number>` — returns `importRunId`
  - `applyShiftImport(tx, result, meta): Promise<number>`
  - `interface ImportMeta { source: ImportSource; filename: string; actorId?: number; passwordHash: string }`
  - `tests/helpers/db.ts` exporting `withTestDb(fn)` — spins a Postgres Testcontainer once per file, runs migrations, truncates between tests.

- [ ] **Step 1: Write the test-database helper**

Create `tests/helpers/db.ts`:

```ts
import { execSync } from 'node:child_process'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from '@prisma/client'

let container: StartedPostgreSqlContainer | undefined
let client: PrismaClient | undefined

/** Boots one Postgres container per test file and migrates it. */
export async function getTestDb(): Promise<PrismaClient> {
  if (client) return client
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = container.getConnectionUri()
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' })
  client = new PrismaClient({ datasources: { db: { url } } })
  return client
}

export async function resetTestDb(): Promise<void> {
  const db = await getTestDb()
  await db.$executeRawUnsafe(`
    TRUNCATE "Claim", "ShiftRequirement", "Shift", "ShiftSeries",
             "ImportRowResult", "ImportRun", "EventOutbox", "User" RESTART IDENTITY CASCADE
  `)
}

export async function stopTestDb(): Promise<void> {
  await client?.$disconnect()
  await container?.stop()
  client = undefined
  container = undefined
}
```

- [ ] **Step 2: Write the persistence test**

Create `tests/import/apply.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const META = { source: 'SEED' as const, filename: 'staff.csv', passwordHash: 'x' }

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('applyStaffImport', () => {
  it('persists one user per accepted record and one report row per source line', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) => applyStaffImport(tx, result, META))

    expect(await db.user.count({ where: { role: 'STAFF' } })).toBe(34)
    expect(await db.importRowResult.count({ where: { importRunId: runId } })).toBe(41)
  })

  it('records the raw line and the issues on every report row', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) => applyStaffImport(tx, result, META))

    const janitor = await db.importRowResult.findFirst({
      where: { importRunId: runId, rawRow: { contains: 'Janitor' } },
    })
    expect(janitor!.outcome).toBe('REJECTED')
    expect(JSON.stringify(janitor!.issues)).toContain('UNKNOWN_PROFESSION')
  })

  it('is idempotent — re-running the import does not duplicate users', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    await db.$transaction((tx) => applyStaffImport(tx, result, META))
    await db.$transaction((tx) => applyStaffImport(tx, result, META))
    expect(await db.user.count({ where: { role: 'STAFF' } })).toBe(34)
  })
})

describe('applyShiftImport', () => {
  it('persists 109 shifts with their requirement rows', async () => {
    const db = await getTestDb()
    const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyShiftImport(tx, result, { ...META, filename: 'shifts.csv' }), { timeout: 30_000 })

    expect(await db.shift.count()).toBe(109)
    expect(await db.shiftRequirement.count()).toBe(109 * 3)
  })

  it('stores the nurse demand the golden test predicts', async () => {
    const db = await getTestDb()
    const result = runShiftImport(readFileSync('shifts.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyShiftImport(tx, result, { ...META, filename: 'shifts.csv' }), { timeout: 30_000 })

    const agg = await db.shiftRequirement.aggregate({
      _sum: { requiredCount: true }, where: { profession: 'NURSE' },
    })
    expect(agg._sum.requiredCount).toBe(226)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- tests/import/apply.test.ts`
Expected: FAIL — `@/lib/import/apply` not found. (First run pulls the Postgres image; allow a minute.)

- [ ] **Step 4: Implement `apply.ts`**

Create `lib/import/apply.ts`:

```ts
import type { ImportSource, Prisma } from '@prisma/client'
import type { ImportResult } from './reconcile'
import type { StaffRecord } from './staff'
import type { ShiftRecord } from './shifts'

export interface ImportMeta {
  source: ImportSource
  filename: string
  actorId?: number
  /** Pre-hashed shared demo password for imported staff. */
  passwordHash: string
}

/** Writes the ImportRun plus one ImportRowResult per source line. */
async function writeRun<T>(
  tx: Prisma.TransactionClient,
  result: ImportResult<T>,
  meta: ImportMeta,
  fileKind: 'STAFF' | 'SHIFT',
  entityIdFor: (row: ImportResult<T>['rows'][number]) => number | null,
): Promise<number> {
  const run = await tx.importRun.create({
    data: {
      source: meta.source,
      fileKind,
      filename: meta.filename,
      actorId: meta.actorId ?? null,
      stats: result.stats,
    },
  })

  await tx.importRowResult.createMany({
    data: result.rows.map((row) => ({
      importRunId: run.id,
      rowNumber: row.rowNumber,
      rawRow: row.raw,
      outcome: row.outcome,
      issues: row.issues as unknown as Prisma.InputJsonValue,
      entityId: entityIdFor(row),
    })),
  })

  return run.id
}

export async function applyStaffImport(
  tx: Prisma.TransactionClient,
  result: ImportResult<StaffRecord>,
  meta: ImportMeta,
): Promise<number> {
  for (const record of result.accepted) {
    await tx.user.upsert({
      where: { externalId: record.externalId },
      create: {
        externalId: record.externalId,
        email: record.email,
        name: record.name,
        passwordHash: meta.passwordHash,
        role: 'STAFF',
        profession: record.profession,
      },
      update: {
        email: record.email,
        name: record.name,
        profession: record.profession,
      },
    })
  }

  const byExternalId = new Map(
    (await tx.user.findMany({
      where: { externalId: { in: result.accepted.map((r) => r.externalId) } },
      select: { id: true, externalId: true },
    })).map((u) => [u.externalId!, u.id]),
  )

  return writeRun(tx, result, meta, 'STAFF', (row) =>
    row.record ? byExternalId.get(row.record.externalId) ?? null : null)
}

export async function applyShiftImport(
  tx: Prisma.TransactionClient,
  result: ImportResult<ShiftRecord>,
  meta: ImportMeta,
): Promise<number> {
  for (const record of result.accepted) {
    const shift = await tx.shift.upsert({
      where: { externalId: record.externalId },
      create: { externalId: record.externalId, startsAt: record.startsAt, endsAt: record.endsAt },
      update: { startsAt: record.startsAt, endsAt: record.endsAt },
    })

    for (const [profession, requiredCount] of Object.entries(record.requirements)) {
      await tx.shiftRequirement.upsert({
        where: { shiftId_profession: { shiftId: shift.id, profession: profession as never } },
        create: { shiftId: shift.id, profession: profession as never, requiredCount },
        update: { requiredCount },
      })
    }
  }

  const byExternalId = new Map(
    (await tx.shift.findMany({
      where: { externalId: { in: result.accepted.map((r) => r.externalId) } },
      select: { id: true, externalId: true },
    })).map((s) => [s.externalId!, s.id]),
  )

  return writeRun(tx, result, meta, 'SHIFT', (row) =>
    row.record ? byExternalId.get(row.record.externalId) ?? null : null)
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -- tests/import/apply.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/import/apply.ts tests/import/apply.test.ts tests/helpers
git commit -m "feat: persist import results as users, shifts and report rows

Upserts keyed on the source CSV id make re-running the import idempotent,
so the seed can run on every boot without duplicating the roster.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Auth and the RBAC capability catalog

**Files:**
- Create: `lib/auth/permissions.ts`, `lib/auth/config.ts`, `lib/auth/with-auth.ts`, `auth.ts`, `middleware.ts`
- Test: `tests/rbac/permissions.test.ts`, `tests/rbac/routes.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2), `createAppError`/`statusFor` (Task 3).
- Produces:
  - `type Permission` — the union in §6.3
  - `ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>>`
  - `can(session, permission): boolean`
  - `withAuth<T>(permission, handler)` — wraps a route handler; `handler` receives `(req, ctx, session)` where `session.user` is `{ id, role, profession, name, email }`
  - `auth()` from Auth.js v5

- [ ] **Step 1: Write the permissions test**

Create `tests/rbac/permissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, can } from '@/lib/auth/permissions'

const manager = { id: 1, role: 'MANAGER' as const, profession: null }
const staff   = { id: 2, role: 'STAFF' as const, profession: 'NURSE' as const }

describe('ROLE_PERMISSIONS', () => {
  it('gives a manager every permission', () => {
    for (const p of ALL_PERMISSIONS) expect(can(manager, p), p).toBe(true)
  })

  it('lets staff act only on their own claims', () => {
    expect(can(staff, 'claim:create:self')).toBe(true)
    expect(can(staff, 'claim:delete:self')).toBe(true)
    expect(can(staff, 'claim:create:any')).toBe(false)
    expect(can(staff, 'claim:delete:any')).toBe(false)
  })

  it('keeps staff out of shift management', () => {
    for (const p of ['shift:create', 'shift:update', 'shift:delete'] as const) {
      expect(can(staff, p), p).toBe(false)
    }
  })

  it('keeps staff out of the importer entirely', () => {
    expect(can(staff, 'import:run')).toBe(false)
    expect(can(staff, 'import:read')).toBe(false)
  })

  it('lets staff read shifts so they can find work', () => {
    expect(can(staff, 'shift:read')).toBe(true)
  })
})
```

- [ ] **Step 2: Write the route-coverage test**

Create `tests/rbac/routes.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Structural guard: every API route file must route its handlers through
 * withAuth. A new endpoint that forgets its permission fails here rather
 * than shipping open. §6.3
 */
describe('API route authorisation coverage', () => {
  const files = globSync('app/api/**/route.ts')

  it('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s declares a permission via withAuth', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src, `${file} must import withAuth`).toContain('withAuth')
    // Every exported HTTP verb must be produced by withAuth(...)
    const verbs = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\s*=\s*([^\n]+)/g)]
    expect(verbs.length, `${file} exports no HTTP handlers`).toBeGreaterThan(0)
    for (const [, verb, rhs] of verbs) {
      expect(rhs, `${file} ${verb} must be wrapped in withAuth`).toContain('withAuth(')
    }
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- tests/rbac`
Expected: FAIL — `@/lib/auth/permissions` not found; no route files yet.

- [ ] **Step 4: Implement `permissions.ts`**

Create `lib/auth/permissions.ts`:

```ts
import type { Profession, Role } from '@prisma/client'

export const ALL_PERMISSIONS = [
  'shift:read', 'shift:create', 'shift:update', 'shift:delete',
  'claim:create:self', 'claim:create:any',
  'claim:delete:self', 'claim:delete:any',
  'import:run', 'import:read',
  'staff:read',
] as const

export type Permission = (typeof ALL_PERMISSIONS)[number]

export interface Principal {
  id: number
  role: Role
  profession: Profession | null
}

const STAFF_PERMISSIONS: Permission[] = [
  'shift:read',
  'claim:create:self',
  'claim:delete:self',
  'staff:read',
]

/**
 * The single source of truth for who may do what. Imported by the server to
 * enforce and by the client to disable controls, so the button a user cannot
 * press and the endpoint that would reject them never disagree. §6.3
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  MANAGER: new Set(ALL_PERMISSIONS),
  STAFF: new Set(STAFF_PERMISSIONS),
}

export function can(principal: Principal | null | undefined, permission: Permission): boolean {
  if (!principal) return false
  return ROLE_PERMISSIONS[principal.role].has(permission)
}

/**
 * Resolves a `:self`/`:any` pair for a target user. Returns the permission that
 * actually applies, so callers ask one question instead of branching on role.
 */
export function scopedPermission(
  principal: Principal,
  base: 'claim:create' | 'claim:delete',
  targetUserId: number,
): Permission {
  return principal.id === targetUserId ? `${base}:self` : `${base}:any`
}
```

- [ ] **Step 5: Implement the Auth.js config**

Create `lib/auth/config.ts`:

```ts
import Credentials from 'next-auth/providers/credentials'
import type { NextAuthConfig } from 'next-auth'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const email = String(raw?.email ?? '').trim().toLowerCase()
        const password = String(raw?.password ?? '')
        if (!email || !password) return null

        const user = await prisma.user.findUnique({ where: { email } })
        if (!user) return null
        if (!(await bcrypt.compare(password, user.passwordHash))) return null

        return {
          id: String(user.id),
          email: user.email,
          name: user.name,
          role: user.role,
          profession: user.profession,
        }
      },
    }),
  ],
  callbacks: {
    // role and profession ride in the JWT so permission checks need no DB hit (§6.3)
    jwt({ token, user }) {
      if (user) {
        token.uid = Number(user.id)
        token.role = user.role
        token.profession = user.profession
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.uid as number
      session.user.role = token.role as never
      session.user.profession = token.profession as never
      return session
    },
  },
}
```

Create `auth.ts` at the repo root:

```ts
import NextAuth from 'next-auth'
import { authConfig } from '@/lib/auth/config'

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig)
```

Create `types/next-auth.d.ts`:

```ts
import type { Profession, Role } from '@prisma/client'
import 'next-auth'

declare module 'next-auth' {
  interface User { role: Role; profession: Profession | null }
  interface Session {
    user: { id: number; email: string; name: string; role: Role; profession: Profession | null }
  }
}
```

- [ ] **Step 6: Implement `with-auth.ts`**

Create `lib/auth/with-auth.ts`:

```ts
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { statusFor, type AppError } from '@/lib/domain/errors'
import { can, type Permission, type Principal } from './permissions'

export interface AuthedContext<P = Record<string, string>> {
  params: Promise<P>
  principal: Principal
}

export type AuthedHandler<P> = (
  req: Request,
  ctx: AuthedContext<P>,
) => Promise<Response>

/**
 * Wraps a route handler with authentication and a declared permission.
 * Every handler in app/api must be produced by this function — a route that
 * forgets is caught by tests/rbac/routes.test.ts. §6.3
 */
export function withAuth<P = Record<string, string>>(
  permission: Permission,
  handler: AuthedHandler<P>,
) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    const session = await auth()
    if (!session?.user) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Sign in required.' } }, { status: 401 })
    }

    const principal: Principal = {
      id: session.user.id,
      role: session.user.role,
      profession: session.user.profession,
    }

    if (!can(principal, permission)) {
      return NextResponse.json(
        { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' } },
        { status: 403 },
      )
    }

    return handler(req, { params: ctx.params, principal })
  }
}

/** Uniform error body for domain failures. */
export function errorResponse(err: AppError): Response {
  return NextResponse.json({ error: err }, { status: statusFor(err.code) })
}
```

Create `middleware.ts`:

```ts
import { auth } from '@/auth'

export default auth((req) => {
  const isApp = req.nextUrl.pathname.startsWith('/dashboard')
    || req.nextUrl.pathname.startsWith('/shifts')
    || req.nextUrl.pathname.startsWith('/my-shifts')
    || req.nextUrl.pathname.startsWith('/import')

  if (isApp && !req.auth) {
    const url = new URL('/login', req.nextUrl.origin)
    url.searchParams.set('next', req.nextUrl.pathname)
    return Response.redirect(url)
  }
})

export const config = {
  matcher: ['/dashboard/:path*', '/shifts/:path*', '/my-shifts/:path*', '/import/:path*'],
}
```

- [ ] **Step 7: Run the permissions test to verify it passes**

Run: `npm test -- tests/rbac/permissions.test.ts`
Expected: PASS, 5 tests.

`tests/rbac/routes.test.ts` still fails ("finds route files to check") because no
routes exist yet. That is correct — it starts passing in Task 11 and guards every
route added after.

- [ ] **Step 8: Commit**

```bash
git add lib/auth auth.ts middleware.ts types tests/rbac
git commit -m "feat: add RBAC capability catalog and withAuth route wrapper

Permissions live in one table shared by server enforcement and client control
state. A structural test asserts every API route is produced by withAuth, so a
new endpoint cannot ship without declaring a permission.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Rules engine — validator, advisory locks, claim assignment

**Files:**
- Create: `lib/rules/validate.ts`, `lib/rules/locks.ts`, `lib/rules/assign.ts`, `lib/events/outbox.ts`, `lib/events/topics.ts`
- Test: `tests/rules/validate.test.ts`, `tests/concurrency/claim.test.ts`

**Interfaces:**
- Consumes: `overlaps` (Task 3), `createAppError` (Task 3), `prisma` (Task 2).
- Produces:
  - `interface ShiftForValidation { id: number; startsAt: Date; endsAt: Date; requirements: { profession: Profession; requiredCount: number }[] }`
  - `interface ClaimContext { claimsByProfession: Record<Profession, number>; userOtherShifts: Interval[] }`
  - `validateAssignment(shift, user, ctx, now): AppError | null` — **pure**
  - `withOrderedLocks(tx, { shiftIds, userIds }, fn)`
  - `assignClaim(input): Promise<{ claimId: number } | AppError>` — **the only function that creates a Claim**
  - `unassignClaim(input): Promise<{ ok: true } | AppError>`
  - `emitEvent(tx, { topic, type, payload, mutationId })`
  - `weekTopic(d: Date): string`

- [ ] **Step 1: Write the validator test**

Create `tests/rules/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateAssignment } from '@/lib/rules/validate'

const NOW = new Date('2026-08-01T00:00:00Z')

const shift = (over: Partial<Parameters<typeof validateAssignment>[0]> = {}) => ({
  id: 1,
  startsAt: new Date('2026-08-12T07:00:00Z'),
  endsAt: new Date('2026-08-12T15:00:00Z'),
  requirements: [
    { profession: 'NURSE' as const, requiredCount: 2 },
    { profession: 'DOCTOR' as const, requiredCount: 1 },
    { profession: 'RECEPTIONIST' as const, requiredCount: 0 },
  ],
  ...over,
})

const nurse = { id: 7, profession: 'NURSE' as const }
const ctx = (over = {}) => ({
  claimsByProfession: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 0 },
  userOtherShifts: [],
  ...over,
})

describe('validateAssignment', () => {
  it('accepts a nurse when a nurse slot is free', () => {
    expect(validateAssignment(shift(), nurse, ctx(), NOW)).toBeNull()
  })

  it('rejects a claim on a shift that has already started', () => {
    const err = validateAssignment(shift(), nurse, ctx(), new Date('2026-08-12T08:00:00Z'))
    expect(err!.code).toBe('SHIFT_IN_PAST')
  })

  it('rejects a profession the shift does not need', () => {
    const err = validateAssignment(shift(), { id: 9, profession: 'RECEPTIONIST' }, ctx(), NOW)
    expect(err!.code).toBe('PROFESSION_NOT_REQUIRED')
  })

  it('rejects when the profession is already full and says the numbers', () => {
    const err = validateAssignment(shift(), nurse,
      ctx({ claimsByProfession: { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } }), NOW)
    expect(err!.code).toBe('ROLE_FULL')
    expect(err!.message).toContain('2 of 2')
  })

  it('allows a doctor onto a shift whose nurse slots are full', () => {
    expect(validateAssignment(shift(), { id: 8, profession: 'DOCTOR' },
      ctx({ claimsByProfession: { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } }), NOW)).toBeNull()
  })

  it('rejects a shift overlapping one the user already holds', () => {
    const err = validateAssignment(shift(), nurse, ctx({
      userOtherShifts: [{
        startsAt: new Date('2026-08-12T13:00:00Z'),
        endsAt: new Date('2026-08-12T21:00:00Z'),
      }],
    }), NOW)
    expect(err!.code).toBe('OVERLAP')
  })

  it('allows a back-to-back shift that only touches at the boundary', () => {
    expect(validateAssignment(shift(), nurse, ctx({
      userOtherShifts: [{
        startsAt: new Date('2026-08-12T15:00:00Z'),
        endsAt: new Date('2026-08-12T23:00:00Z'),
      }],
    }), NOW)).toBeNull()
  })

  it('rejects a manager with no profession — managers claim as themselves, not as staff', () => {
    const err = validateAssignment(shift(), { id: 1, profession: null }, ctx(), NOW)
    expect(err!.code).toBe('PROFESSION_NOT_REQUIRED')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/rules/validate.test.ts`
Expected: FAIL — `@/lib/rules/validate` not found.

- [ ] **Step 3: Implement `validate.ts`**

Create `lib/rules/validate.ts`:

```ts
import type { Profession } from '@prisma/client'
import { overlaps, type Interval } from '@/lib/domain/time'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { PROFESSION_LABELS } from '@/lib/domain/profession'

export interface ShiftForValidation {
  id: number
  startsAt: Date
  endsAt: Date
  requirements: { profession: Profession; requiredCount: number }[]
}

export interface UserForValidation {
  id: number
  profession: Profession | null
}

export interface ClaimContext {
  /** How many claims the shift already holds, per profession. */
  claimsByProfession: Record<Profession, number>
  /** Every OTHER shift this user already holds, as intervals. */
  userOtherShifts: Interval[]
}

const timeLabel = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short',
    timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
  }).format(d)

/**
 * The single arbiter of whether a person may hold a shift (§4.1).
 *
 * Pure: it decides from data the caller already loaded, so it is trivially
 * unit-testable and can be re-run against a *proposed* shift state during an
 * edit preview without writing anything.
 */
export function validateAssignment(
  shift: ShiftForValidation,
  user: UserForValidation,
  ctx: ClaimContext,
  now: Date,
): AppError | null {
  if (shift.startsAt <= now) {
    return createAppError('SHIFT_IN_PAST', 'This shift has already started.')
  }

  const requirement = user.profession
    ? shift.requirements.find((r) => r.profession === user.profession)
    : undefined

  if (!user.profession || !requirement || requirement.requiredCount === 0) {
    const label = user.profession ? PROFESSION_LABELS[user.profession].toLowerCase() : 'that role'
    return createAppError('PROFESSION_NOT_REQUIRED',
      `This shift does not need a ${label}.`)
  }

  const filled = ctx.claimsByProfession[user.profession]
  if (filled >= requirement.requiredCount) {
    const label = PROFESSION_LABELS[user.profession].toLowerCase()
    return createAppError('ROLE_FULL',
      `This shift already has ${filled} of ${requirement.requiredCount} ${label}s.`,
      { profession: user.profession, filled, required: requirement.requiredCount })
  }

  const conflict = ctx.userOtherShifts.find((other) => overlaps(shift, other))
  if (conflict) {
    return createAppError('OVERLAP',
      `Overlaps a shift you already hold, ${timeLabel(conflict.startsAt)}–${timeLabel(conflict.endsAt)}.`,
      { conflictStartsAt: conflict.startsAt.toISOString() })
  }

  return null
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/rules/validate.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Implement `locks.ts`**

Create `lib/rules/locks.ts`:

```ts
import type { Prisma } from '@prisma/client'

/** Advisory-lock namespaces. Distinct so a shift id and a user id never collide. */
const NS = { SHIFT: 1, USER: 2 } as const

/**
 * Takes transaction-scoped advisory locks in a fixed global order — all shift
 * ids first, then all user ids, each ascending (§4.2).
 *
 * The ordering is the whole point: a shift edit locks one shift and many users
 * while a staff member may be concurrently claiming. Without a total order those
 * two can deadlock; with one they simply queue.
 */
export async function withOrderedLocks<T>(
  tx: Prisma.TransactionClient,
  ids: { shiftIds?: number[]; userIds?: number[] },
  fn: () => Promise<T>,
): Promise<T> {
  const shiftIds = [...new Set(ids.shiftIds ?? [])].sort((a, b) => a - b)
  const userIds = [...new Set(ids.userIds ?? [])].sort((a, b) => a - b)

  for (const id of shiftIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS.SHIFT}::int, ${id}::int)`
  }
  for (const id of userIds) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NS.USER}::int, ${id}::int)`
  }

  return fn()
}
```

- [ ] **Step 6: Implement the event outbox**

Create `lib/events/topics.ts`:

```ts
import { isoWeekOf } from '@/lib/domain/time'

/** Subscribers listen per week, so a claim on Aug 12 never wakes an Aug 20 viewer. §7.1 */
export const weekTopic = (d: Date): string => `week:${isoWeekOf(d)}`

export const EVENT_TYPES = [
  'shift.created', 'shift.edited', 'shift.deleted',
  'shift.claimed', 'shift.unclaimed', 'shift.claims_dropped',
] as const

export type EventType = (typeof EVENT_TYPES)[number]
```

Create `lib/events/outbox.ts`:

```ts
import type { Prisma } from '@prisma/client'
import type { EventType } from './topics'

export interface EmitInput {
  topic: string
  type: EventType
  payload: Record<string, unknown>
  mutationId?: string
}

/**
 * Appends to the outbox INSIDE the caller's transaction. A database trigger
 * turns the insert into a Realtime broadcast, so an event is emitted if and
 * only if the mutation commits (§7.1). Never call this outside a transaction.
 */
export async function emitEvent(tx: Prisma.TransactionClient, input: EmitInput): Promise<void> {
  await tx.eventOutbox.create({
    data: {
      topic: input.topic,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
      mutationId: input.mutationId ?? null,
    },
  })
}
```

- [ ] **Step 7: Write the concurrency test**

Create `tests/concurrency/claim.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const FUTURE = new Date('2026-12-01T09:00:00Z')
const FUTURE_END = new Date('2026-12-01T17:00:00Z')

async function seedShiftAndNurses(nurseCount: number, requiredNurses = 2) {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: FUTURE_END,
      requirements: {
        create: [
          { profession: 'NURSE', requiredCount: requiredNurses },
          { profession: 'DOCTOR', requiredCount: 0 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ],
      },
    },
  })
  const nurses = await Promise.all(
    Array.from({ length: nurseCount }, (_, i) =>
      db.user.create({
        data: {
          email: `n${i}@c.test`, name: `Nurse ${i}`, passwordHash: 'x',
          role: 'STAFF', profession: 'NURSE',
        },
      })),
  )
  return { shift, nurses }
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('concurrent claiming', () => {
  it('lets exactly 2 of 10 simultaneous nurses onto a 2-nurse shift', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(10, 2)

    const results = await Promise.all(
      nurses.map((n) => assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })),
    )

    const won = results.filter((r) => 'claimId' in r)
    const lost = results.filter((r) => 'code' in r)

    expect(won).toHaveLength(2)
    expect(lost).toHaveLength(8)
    expect(lost.every((r) => (r as { code: string }).code === 'ROLE_FULL')).toBe(true)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(2)
  })

  it('never lets the same nurse claim one shift twice under a race', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(1, 2)
    const nurse = nurses[0]!

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })),
    )

    expect(results.filter((r) => 'claimId' in r)).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
  })

  it('rejects the second of two overlapping shifts claimed simultaneously', async () => {
    const db = await getTestDb()
    const { nurses } = await seedShiftAndNurses(1, 2)
    const nurse = nurses[0]!

    const mk = (startsAt: Date, endsAt: Date) => db.shift.create({
      data: {
        startsAt, endsAt,
        requirements: { create: [
          { profession: 'NURSE', requiredCount: 2 },
          { profession: 'DOCTOR', requiredCount: 0 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ] },
      },
    })

    const a = await mk(new Date('2026-12-02T09:00:00Z'), new Date('2026-12-02T17:00:00Z'))
    const b = await mk(new Date('2026-12-02T14:00:00Z'), new Date('2026-12-02T22:00:00Z'))

    const results = await Promise.all([
      assignClaim({ db, shiftId: a.id, userId: nurse.id, actorId: nurse.id }),
      assignClaim({ db, shiftId: b.id, userId: nurse.id, actorId: nurse.id }),
    ])

    expect(results.filter((r) => 'claimId' in r)).toHaveLength(1)
    expect(results.filter((r) => 'code' in r && r.code === 'OVERLAP')).toHaveLength(1)
    expect(await db.claim.count({ where: { userId: nurse.id } })).toBe(1)
  })

  it('writes exactly one outbox event per successful claim', async () => {
    const db = await getTestDb()
    const { shift, nurses } = await seedShiftAndNurses(10, 2)

    await Promise.all(nurses.map((n) =>
      assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })))

    expect(await db.eventOutbox.count({ where: { type: 'shift.claimed' } })).toBe(2)
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -- tests/concurrency/claim.test.ts`
Expected: FAIL — `@/lib/rules/assign` not found.

- [ ] **Step 9: Implement `assign.ts`**

Create `lib/rules/assign.ts`:

```ts
import { Prisma, type PrismaClient, type Profession } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { withOrderedLocks } from './locks'
import { validateAssignment, type ClaimContext } from './validate'

export interface AssignInput {
  db: PrismaClient
  shiftId: number
  userId: number
  /** Who performed the action — the claimant themselves, or a manager. */
  actorId: number
  mutationId?: string
  now?: Date
}

const ZERO: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

/** Retries a transaction on serialization failure and deadlock (§4.2). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const code = (err as { code?: string }).code
      // 40001 serialization_failure, 40P01 deadlock_detected
      if (code !== '40001' && code !== '40P01') throw err
      lastError = err
      await new Promise((r) => setTimeout(r, 10 * (i + 1) + Math.floor(Math.random() * 10)))
    }
  }
  throw lastError
}

/**
 * The ONLY function in the codebase that creates a Claim (§4.1). Staff claims,
 * manager assignments and the seeder all land here, which is what makes the
 * business rules hold for every path by construction rather than by discipline.
 */
export async function assignClaim(
  input: AssignInput,
): Promise<{ claimId: number } | AppError> {
  const now = input.now ?? new Date()

  return withRetry(() =>
    input.db.$transaction(async (tx) =>
      withOrderedLocks(tx, { shiftIds: [input.shiftId], userIds: [input.userId] }, async () => {
        const shift = await tx.shift.findUnique({
          where: { id: input.shiftId },
          include: { requirements: true },
        })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

        const user = await tx.user.findUnique({ where: { id: input.userId } })
        if (!user) return createAppError('NOT_FOUND', 'That staff member no longer exists.')

        const existing = await tx.claim.findUnique({
          where: { shiftId_userId: { shiftId: shift.id, userId: user.id } },
        })
        if (existing) return createAppError('ALREADY_CLAIMED', 'You already hold this shift.')

        // Counts and the user's other shifts are read INSIDE the lock, so the
        // validator sees a state no concurrent claim can be mutating.
        const grouped = await tx.claim.findMany({
          where: { shiftId: shift.id },
          select: { user: { select: { profession: true } } },
        })
        const claimsByProfession = { ...ZERO }
        for (const c of grouped) {
          if (c.user.profession) claimsByProfession[c.user.profession] += 1
        }

        const otherClaims = await tx.claim.findMany({
          where: { userId: user.id, shiftId: { not: shift.id } },
          select: { shift: { select: { startsAt: true, endsAt: true } } },
        })

        const ctx: ClaimContext = {
          claimsByProfession,
          userOtherShifts: otherClaims.map((c) => c.shift),
        }

        const failure = validateAssignment(shift, user, ctx, now)
        if (failure) return failure

        const claim = await tx.claim.create({
          data: {
            shiftId: shift.id,
            userId: user.id,
            assignedById: input.actorId === user.id ? null : input.actorId,
          },
        })

        await emitEvent(tx, {
          topic: weekTopic(shift.startsAt),
          type: 'shift.claimed',
          payload: {
            shiftId: shift.id, userId: user.id,
            profession: user.profession, name: user.name,
          },
          mutationId: input.mutationId,
        })

        return { claimId: claim.id }
      }),
    ).catch((err: unknown) => {
      // The unique constraint is the last line of defence behind the lock.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return createAppError('ALREADY_CLAIMED', 'You already hold this shift.')
      }
      throw err
    }),
  )
}

export interface UnassignInput {
  db: PrismaClient
  shiftId: number
  userId: number
  mutationId?: string
  now?: Date
}

export async function unassignClaim(input: UnassignInput): Promise<{ ok: true } | AppError> {
  const now = input.now ?? new Date()

  return withRetry(() =>
    input.db.$transaction(async (tx) =>
      withOrderedLocks(tx, { shiftIds: [input.shiftId], userIds: [input.userId] }, async () => {
        const shift = await tx.shift.findUnique({ where: { id: input.shiftId } })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')
        if (shift.startsAt <= now) {
          return createAppError('SHIFT_IN_PAST', 'This shift has already started and cannot be changed.')
        }

        const claim = await tx.claim.findUnique({
          where: { shiftId_userId: { shiftId: input.shiftId, userId: input.userId } },
        })
        if (!claim) return createAppError('NOT_CLAIMED', 'That person does not hold this shift.')

        await tx.claim.delete({ where: { id: claim.id } })

        await emitEvent(tx, {
          topic: weekTopic(shift.startsAt),
          type: 'shift.unclaimed',
          payload: { shiftId: shift.id, userId: input.userId },
          mutationId: input.mutationId,
        })

        return { ok: true as const }
      }),
    ),
  )
}
```

- [ ] **Step 10: Run the concurrency test to verify it passes**

Run: `npm test -- tests/concurrency/claim.test.ts`
Expected: PASS, 4 tests.

The first test is the brief's core claim — "a shift's availability should stay accurate
no matter how many people are acting on it at once". If it yields 3 winners, the
advisory lock is not being taken before the count is read.

- [ ] **Step 11: Commit**

```bash
git add lib/rules lib/events tests/rules tests/concurrency
git commit -m "feat: add claim validator with advisory-locked assignment

validateAssignment is pure and decides from pre-loaded data, so it can be
re-run against a proposed shift state during an edit preview. assignClaim is
the sole writer of Claim rows and reads its counts inside the lock, so ten
simultaneous nurses on a two-nurse shift yield exactly two winners.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Shift edit — preview and confirm with version guard

**Files:**
- Create: `lib/rules/edit.ts`
- Test: `tests/rules/edit.test.ts`

**Interfaces:**
- Consumes: `validateAssignment` (Task 10), `withOrderedLocks` (Task 10), `emitEvent` (Task 10).
- Produces:
  - `interface ProposedShift { startsAt: Date; endsAt: Date; requirements: Record<Profession, number> }`
  - `interface DroppedClaim { userId: number; name: string; profession: Profession; reason: string; code: RuleCode }`
  - `interface EditPreview { version: number; kept: number[]; dropped: DroppedClaim[] }`
  - `previewShiftEdit(db, shiftId, proposed, now?): Promise<EditPreview | AppError>`
  - `commitShiftEdit(db, shiftId, proposed, expectedVersion, mutationId?, now?): Promise<EditPreview | AppError>`
  - `previewShiftDelete(db, shiftId)` / `commitShiftDelete(db, shiftId, expectedVersion, mutationId?)`

- [ ] **Step 1: Write the edit test**

Create `tests/rules/edit.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { commitShiftEdit, previewShiftEdit } from '@/lib/rules/edit'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const D = (s: string) => new Date(s)

async function makeShift(startsAt: Date, endsAt: Date, nurses = 2, doctors = 0) {
  const db = await getTestDb()
  return db.shift.create({
    data: {
      startsAt, endsAt,
      requirements: { create: [
        { profession: 'NURSE', requiredCount: nurses },
        { profession: 'DOCTOR', requiredCount: doctors },
        { profession: 'RECEPTIONIST', requiredCount: 0 },
      ] },
    },
  })
}

async function makeNurse(i: number) {
  const db = await getTestDb()
  return db.user.create({
    data: { email: `n${i}@c.test`, name: `Nurse ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
  })
}

const REQ = { NURSE: 2, DOCTOR: 0, RECEPTIONIST: 0 } as const

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('previewShiftEdit', () => {
  it('keeps every claim when the new time breaks nothing', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { ...REQ },
    })

    expect('dropped' in preview && preview.dropped).toEqual([])
    expect('kept' in preview && preview.kept).toEqual([nurse.id])
  })

  it('drops the claim that the new time makes overlap another shift', async () => {
    const db = await getTestDb()
    const a = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const b = await makeShift(D('2026-12-02T09:00Z'), D('2026-12-02T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: a.id, userId: nurse.id, actorId: nurse.id })
    await assignClaim({ db, shiftId: b.id, userId: nurse.id, actorId: nurse.id })

    // Move b on top of a
    const preview = await previewShiftEdit(db, b.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { ...REQ },
    })

    expect('dropped' in preview && preview.dropped).toHaveLength(1)
    expect('dropped' in preview && preview.dropped[0]!.code).toBe('OVERLAP')
  })

  it('drops the most recently claimed person when the requirement is lowered', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })
    await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    })

    expect('dropped' in preview && preview.dropped.map((d) => d.userId)).toEqual([second.id])
    expect('kept' in preview && preview.kept).toEqual([first.id])
  })

  it('changes nothing in the database', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'))
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 1 },
    })

    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(0)
  })
})

describe('commitShiftEdit', () => {
  it('applies the edit, drops the right claims and bumps the version', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    const second = await makeNurse(2)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })
    await assignClaim({ db, shiftId: shift.id, userId: second.id, actorId: second.id })

    const result = await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }, 0)

    expect('dropped' in result && result.dropped).toHaveLength(1)
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
    expect((await db.shift.findUnique({ where: { id: shift.id } }))!.version).toBe(1)
  })

  it('refuses a stale confirm when a claim landed after the preview', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 2)
    const first = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: first.id, actorId: first.id })

    const preview = await previewShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt, requirements: { ...REQ },
    })
    const stale = ('version' in preview ? preview.version : 0)

    // A concurrent edit bumps the version between preview and confirm.
    await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt, requirements: { ...REQ },
    }, stale)

    const result = await commitShiftEdit(db, shift.id, {
      startsAt: shift.startsAt, endsAt: shift.endsAt,
      requirements: { NURSE: 0, DOCTOR: 0, RECEPTIONIST: 1 },
    }, stale)

    expect('code' in result && result.code).toBe('VERSION_CONFLICT')
    expect(await db.claim.count({ where: { shiftId: shift.id } })).toBe(1)
  })

  it('emits a claims_dropped event only when somebody was actually dropped', async () => {
    const db = await getTestDb()
    const shift = await makeShift(D('2026-12-01T09:00Z'), D('2026-12-01T17:00Z'), 1)
    const nurse = await makeNurse(1)
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    await commitShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'), requirements: { NURSE: 1, DOCTOR: 0, RECEPTIONIST: 0 },
    }, 0)
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(0)

    await commitShiftEdit(db, shift.id, {
      startsAt: D('2026-12-01T10:00Z'), endsAt: D('2026-12-01T18:00Z'),
      requirements: { NURSE: 0, DOCTOR: 1, RECEPTIONIST: 0 },
    }, 1)
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/rules/edit.test.ts`
Expected: FAIL — `@/lib/rules/edit` not found.

- [ ] **Step 3: Implement `edit.ts`**

Create `lib/rules/edit.ts`:

```ts
import type { PrismaClient, Prisma, Profession } from '@prisma/client'
import { createAppError, type AppError, type RuleCode } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { withOrderedLocks } from './locks'
import { validateAssignment } from './validate'

export interface ProposedShift {
  startsAt: Date
  endsAt: Date
  requirements: Record<Profession, number>
}

export interface DroppedClaim {
  userId: number
  name: string
  profession: Profession
  code: RuleCode
  reason: string
}

export interface EditPreview {
  version: number
  kept: number[]
  dropped: DroppedClaim[]
}

const ZERO: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }

/**
 * Re-runs the claim validator against the PROPOSED shift state and decides who
 * survives (§4.3). Shared verbatim by preview and commit — the preview is the
 * commit in dry-run mode, so the two can never disagree about who gets dropped.
 *
 * Claims are considered oldest-first, so when a requirement is lowered the most
 * recently made commitments are the ones dropped.
 */
async function computeSurvivors(
  tx: Prisma.TransactionClient,
  shiftId: number,
  proposed: ProposedShift,
  now: Date,
): Promise<EditPreview> {
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } })

  const claims = await tx.claim.findMany({
    where: { shiftId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true, profession: true } } },
  })

  const requirements = (Object.keys(proposed.requirements) as Profession[])
    .map((profession) => ({ profession, requiredCount: proposed.requirements[profession] }))

  const proposedShift = { id: shiftId, startsAt: proposed.startsAt, endsAt: proposed.endsAt, requirements }

  const running = { ...ZERO }
  const kept: number[] = []
  const dropped: DroppedClaim[] = []

  for (const claim of claims) {
    // The holder's OTHER shifts, so a retimed shift can be detected as overlapping.
    const others = await tx.claim.findMany({
      where: { userId: claim.userId, shiftId: { not: shiftId } },
      select: { shift: { select: { startsAt: true, endsAt: true } } },
    })

    const failure = validateAssignment(
      proposedShift,
      { id: claim.userId, profession: claim.user.profession },
      { claimsByProfession: running, userOtherShifts: others.map((o) => o.shift) },
      now,
    )

    if (failure) {
      dropped.push({
        userId: claim.userId,
        name: claim.user.name,
        profession: claim.user.profession!,
        code: failure.code,
        reason: failure.message,
      })
    } else {
      kept.push(claim.userId)
      if (claim.user.profession) running[claim.user.profession] += 1
    }
  }

  return { version: shift.version, kept, dropped }
}

export async function previewShiftEdit(
  db: PrismaClient,
  shiftId: number,
  proposed: ProposedShift,
  now: Date = new Date(),
): Promise<EditPreview | AppError> {
  const exists = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true } })
  if (!exists) return createAppError('NOT_FOUND', 'That shift no longer exists.')

  // Read-only: runs in a transaction for a consistent snapshot but writes nothing.
  return db.$transaction((tx) => computeSurvivors(tx, shiftId, proposed, now))
}

export async function commitShiftEdit(
  db: PrismaClient,
  shiftId: number,
  proposed: ProposedShift,
  expectedVersion: number,
  mutationId?: string,
  now: Date = new Date(),
): Promise<EditPreview | AppError> {
  return db.$transaction(async (tx) => {
    const claimants = await tx.claim.findMany({ where: { shiftId }, select: { userId: true } })

    return withOrderedLocks(
      tx,
      { shiftIds: [shiftId], userIds: claimants.map((c) => c.userId) },
      async () => {
        const shift = await tx.shift.findUnique({ where: { id: shiftId } })
        if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

        // A claim landing between preview and confirm bumps nothing, so the
        // guard is on the shift version AND a re-computation under lock: the
        // caller is shown the fresh result rather than having a stale plan applied.
        if (shift.version !== expectedVersion) {
          return createAppError('VERSION_CONFLICT',
            'This shift changed while you were reviewing. Re-check the preview and try again.',
            { currentVersion: shift.version })
        }

        const outcome = await computeSurvivors(tx, shiftId, proposed, now)

        if (outcome.dropped.length > 0) {
          await tx.claim.deleteMany({
            where: { shiftId, userId: { in: outcome.dropped.map((d) => d.userId) } },
          })
        }

        const oldStartsAt = shift.startsAt

        await tx.shift.update({
          where: { id: shiftId },
          data: { startsAt: proposed.startsAt, endsAt: proposed.endsAt, version: { increment: 1 } },
        })

        for (const profession of Object.keys(proposed.requirements) as Profession[]) {
          await tx.shiftRequirement.upsert({
            where: { shiftId_profession: { shiftId, profession } },
            create: { shiftId, profession, requiredCount: proposed.requirements[profession] },
            update: { requiredCount: proposed.requirements[profession] },
          })
        }

        // Both weeks are notified when a shift moves across a week boundary.
        const topics = new Set([weekTopic(oldStartsAt), weekTopic(proposed.startsAt)])
        for (const topic of topics) {
          await emitEvent(tx, {
            topic, type: 'shift.edited',
            payload: { shiftId, startsAt: proposed.startsAt.toISOString(), endsAt: proposed.endsAt.toISOString() },
            mutationId,
          })
          if (outcome.dropped.length > 0) {
            await emitEvent(tx, {
              topic, type: 'shift.claims_dropped',
              payload: { shiftId, dropped: outcome.dropped },
              mutationId,
            })
          }
        }

        return { ...outcome, version: shift.version + 1 }
      },
    )
  })
}

export async function previewShiftDelete(
  db: PrismaClient,
  shiftId: number,
): Promise<{ version: number; holders: DroppedClaim[] } | AppError> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    include: { claims: { include: { user: { select: { id: true, name: true, profession: true } } } } },
  })
  if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')

  return {
    version: shift.version,
    holders: shift.claims.map((c) => ({
      userId: c.userId, name: c.user.name, profession: c.user.profession!,
      code: 'NOT_CLAIMED' as const, reason: 'Shift is being deleted.',
    })),
  }
}

export async function commitShiftDelete(
  db: PrismaClient,
  shiftId: number,
  expectedVersion: number,
  mutationId?: string,
): Promise<{ ok: true } | AppError> {
  return db.$transaction(async (tx) => {
    const claimants = await tx.claim.findMany({ where: { shiftId }, select: { userId: true } })

    return withOrderedLocks(tx, { shiftIds: [shiftId], userIds: claimants.map((c) => c.userId) }, async () => {
      const shift = await tx.shift.findUnique({ where: { id: shiftId } })
      if (!shift) return createAppError('NOT_FOUND', 'That shift no longer exists.')
      if (shift.version !== expectedVersion) {
        return createAppError('VERSION_CONFLICT',
          'This shift changed while you were reviewing. Re-check and try again.')
      }

      await emitEvent(tx, {
        topic: weekTopic(shift.startsAt),
        type: 'shift.deleted',
        payload: { shiftId, affectedUserIds: claimants.map((c) => c.userId) },
        mutationId,
      })

      await tx.shift.delete({ where: { id: shiftId } }) // claims cascade

      return { ok: true as const }
    })
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/rules/edit.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/rules/edit.ts tests/rules/edit.test.ts
git commit -m "feat: re-validate claims on shift edit with preview and version guard

Preview and commit share computeSurvivors verbatim, so what the manager is
shown is exactly what gets applied. The commit re-computes under lock and
refuses a stale version, so a claim landing mid-review cannot slip through
unvalidated.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Contracts, pagination and the shift/claim API routes

**Files:**
- Create: `lib/contracts/common.ts`, `lib/contracts/shifts.ts`, `lib/contracts/claims.ts`, `lib/db/paginate.ts`, `app/api/shifts/route.ts`, `app/api/shifts/[id]/route.ts`, `app/api/shifts/[id]/claims/route.ts`, `app/api/shifts/[id]/claims/[userId]/route.ts`, `app/api/staff/route.ts`
- Test: `tests/contracts/paginate.test.ts`, `tests/api/claims.test.ts`

**Interfaces:**
- Consumes: `withAuth`, `errorResponse` (Task 9); `assignClaim`, `unassignClaim` (Task 10); `previewShiftEdit`, `commitShiftEdit`, `previewShiftDelete`, `commitShiftDelete` (Task 11).
- Produces:
  - `encodeCursor(v) / decodeCursor(s)`
  - `paginate<T>(args): Promise<{ items: T[]; nextCursor: string | null }>`
  - `CreateShiftBody`, `UpdateShiftBody`, `CreateClaimBody` Zod schemas + inferred types
  - Route handlers per §6.5

- [ ] **Step 1: Write the pagination test**

Create `tests/contracts/paginate.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, paginate } from '@/lib/db/paginate'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('cursors', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42)
  })

  it('returns null for a malformed cursor rather than throwing', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })
})

describe('paginate', () => {
  async function seed(n: number) {
    const db = await getTestDb()
    for (let i = 0; i < n; i++) {
      await db.user.create({
        data: { email: `u${i}@c.test`, name: `User ${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
    }
    return db
  }

  it('walks every row exactly once across pages', async () => {
    const db = await seed(25)
    const seen: number[] = []
    let cursor: string | null = null

    do {
      const page = await paginate({
        findMany: (args) => db.user.findMany(args), limit: 10, cursor,
      })
      seen.push(...page.items.map((u) => u.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('reports no next cursor on the final page', async () => {
    const db = await seed(5)
    const page = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: null })
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeNull()
  })

  it('does not skip a row when an earlier row is deleted mid-scroll', async () => {
    // The failure mode that offset pagination has and keyset does not.
    const db = await seed(20)
    const first = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: null })
    await db.user.delete({ where: { id: first.items[0]!.id } })
    const second = await paginate({ findMany: (args) => db.user.findMany(args), limit: 10, cursor: first.nextCursor })

    const ids = [...first.items.map((u) => u.id), ...second.items.map((u) => u.id)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.items).toHaveLength(10)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/contracts/paginate.test.ts`
Expected: FAIL — `@/lib/db/paginate` not found.

- [ ] **Step 3: Implement `paginate.ts`**

Create `lib/db/paginate.ts`:

```ts
export function encodeCursor(id: number): string {
  return Buffer.from(`id:${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const m = /^id:(\d+)$/.exec(raw)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

interface FindManyArgs {
  take: number
  skip?: number
  cursor?: { id: number }
  orderBy: { id: 'asc' }
}

export interface PaginateArgs<T> {
  findMany: (args: FindManyArgs) => Promise<T[]>
  limit: number
  cursor: string | null
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Keyset pagination (§6.4). Anchoring on the last row's id rather than an
 * offset means rows inserted or deleted earlier in the list cannot make a
 * later page skip or repeat entries — which matters here because shifts and
 * claims change under a scrolling list in real time.
 */
export async function paginate<T extends { id: number }>(
  args: PaginateArgs<T>,
): Promise<Page<T>> {
  const limit = Math.min(Math.max(args.limit, 1), 100)
  const after = args.cursor ? decodeCursor(args.cursor) : null

  const rows = await args.findMany({
    take: limit + 1, // one extra row tells us whether another page exists
    orderBy: { id: 'asc' },
    ...(after !== null ? { cursor: { id: after }, skip: 1 } : {}),
  })

  const items = rows.slice(0, limit)
  const nextCursor = rows.length > limit && items.length > 0
    ? encodeCursor(items[items.length - 1]!.id)
    : null

  return { items, nextCursor }
}
```

- [ ] **Step 4: Implement the contracts**

Create `lib/contracts/common.ts`:

```ts
import { z } from 'zod'

export const PROFESSION = z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST'])

export const requirementsSchema = z.object({
  DOCTOR: z.number().int().min(0).max(50),
  NURSE: z.number().int().min(0).max(50),
  RECEPTIONIST: z.number().int().min(0).max(50),
}).refine((r) => r.DOCTOR + r.NURSE + r.RECEPTIONIST > 0, {
  message: 'A shift must require at least one person.',
})

export const pageQuerySchema = z.object({
  cursor: z.string().nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    meta: z.record(z.unknown()).optional(),
  }),
})

/** Client-generated id used to suppress a caller's own realtime echo (§7.1). */
export const mutationIdSchema = z.string().min(8).max(64).optional()

export type Requirements = z.infer<typeof requirementsSchema>
```

Create `lib/contracts/shifts.ts`:

```ts
import { z } from 'zod'
import { mutationIdSchema, requirementsSchema } from './common'

/** Clinic-local wall clock, exactly as a manager types it. */
export const localDateTimeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM.'),
})

export const createShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  mutationId: mutationIdSchema,
  recurrence: z.object({
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    untilDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
})

export const updateShiftSchema = localDateTimeSchema.extend({
  requirements: requirementsSchema,
  expectedVersion: z.number().int().min(0),
  mutationId: mutationIdSchema,
})

export const droppedClaimSchema = z.object({
  userId: z.number().int(),
  name: z.string(),
  profession: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST']),
  code: z.string(),
  reason: z.string(),
})

export const editPreviewSchema = z.object({
  version: z.number().int(),
  kept: z.array(z.number().int()),
  dropped: z.array(droppedClaimSchema),
})

export type CreateShiftBody = z.infer<typeof createShiftSchema>
export type UpdateShiftBody = z.infer<typeof updateShiftSchema>
export type EditPreviewResponse = z.infer<typeof editPreviewSchema>
```

Create `lib/contracts/claims.ts`:

```ts
import { z } from 'zod'
import { mutationIdSchema } from './common'

export const createClaimSchema = z.object({
  /** Omitted means "claim for myself"; managers may name another user. */
  userId: z.number().int().positive().optional(),
  mutationId: mutationIdSchema,
})

export const claimResultSchema = z.object({ claimId: z.number().int() })

export type CreateClaimBody = z.infer<typeof createClaimSchema>
```

- [ ] **Step 5: Write the claims API test**

Create `tests/api/claims.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createClaimSchema } from '@/lib/contracts/claims'
import { updateShiftSchema } from '@/lib/contracts/shifts'
import { requirementsSchema } from '@/lib/contracts/common'

describe('claim contract', () => {
  it('accepts an empty body as a self-claim', () => {
    expect(createClaimSchema.parse({})).toEqual({})
  })

  it('accepts a target user for a manager assignment', () => {
    expect(createClaimSchema.parse({ userId: 7 }).userId).toBe(7)
  })

  it('rejects a non-positive user id', () => {
    expect(createClaimSchema.safeParse({ userId: 0 }).success).toBe(false)
  })
})

describe('requirements contract', () => {
  it('rejects a shift that needs nobody', () => {
    expect(requirementsSchema.safeParse({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }).success).toBe(false)
  })

  it('rejects a negative count', () => {
    expect(requirementsSchema.safeParse({ DOCTOR: -1, NURSE: 1, RECEPTIONIST: 0 }).success).toBe(false)
  })
})

describe('update contract', () => {
  it('requires the version the client previewed against', () => {
    const body = {
      date: '2026-08-12', startTime: '08:00', endTime: '16:00',
      requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
    }
    expect(updateShiftSchema.safeParse(body).success).toBe(false)
    expect(updateShiftSchema.safeParse({ ...body, expectedVersion: 0 }).success).toBe(true)
  })
})
```

- [ ] **Step 6: Implement the route handlers**

Create `app/api/shifts/[id]/claims/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { can, scopedPermission } from '@/lib/auth/permissions'
import { createClaimSchema } from '@/lib/contracts/claims'
import { createAppError } from '@/lib/domain/errors'
import { assignClaim } from '@/lib/rules/assign'

export const POST = withAuth<{ id: string }>('claim:create:self', async (req, ctx) => {
  const { id } = await ctx.params
  const shiftId = Number(id)
  if (!Number.isInteger(shiftId)) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))
  }

  const parsed = createClaimSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const targetUserId = parsed.data.userId ?? ctx.principal.id

  // Claiming for somebody else is a strictly stronger permission than for self.
  const required = scopedPermission(ctx.principal, 'claim:create', targetUserId)
  if (!can(ctx.principal, required)) {
    return errorResponse(createAppError('FORBIDDEN', 'You can only claim shifts for yourself.'))
  }

  const result = await assignClaim({
    db: prisma, shiftId, userId: targetUserId,
    actorId: ctx.principal.id, mutationId: parsed.data.mutationId,
  })

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result, { status: 201 })
})
```

Create `app/api/shifts/[id]/claims/[userId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { can, scopedPermission } from '@/lib/auth/permissions'
import { createAppError } from '@/lib/domain/errors'
import { unassignClaim } from '@/lib/rules/assign'

export const DELETE = withAuth<{ id: string; userId: string }>('claim:delete:self', async (req, ctx) => {
  const { id, userId } = await ctx.params
  const shiftId = Number(id)
  const targetUserId = Number(userId)
  if (!Number.isInteger(shiftId) || !Number.isInteger(targetUserId)) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad shift or user id.'))
  }

  const required = scopedPermission(ctx.principal, 'claim:delete', targetUserId)
  if (!can(ctx.principal, required)) {
    return errorResponse(createAppError('FORBIDDEN', 'You can only release your own shifts.'))
  }

  const mutationId = new URL(req.url).searchParams.get('mutationId') ?? undefined
  const result = await unassignClaim({ db: prisma, shiftId, userId: targetUserId, mutationId })

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
```

Create `app/api/shifts/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { updateShiftSchema } from '@/lib/contracts/shifts'
import { createAppError } from '@/lib/domain/errors'
import { clinicWallTimeToUtc } from '@/lib/domain/time'
import {
  commitShiftDelete, commitShiftEdit, previewShiftDelete, previewShiftEdit,
} from '@/lib/rules/edit'

const parseId = (raw: string) => (Number.isInteger(Number(raw)) ? Number(raw) : null)

/** Rolls an end at or before the start onto the next day — same rule as the importer (§5.3). */
function toInstants(date: string, startTime: string, endTime: string) {
  const startsAt = clinicWallTimeToUtc(date, startTime)
  let endsAt = clinicWallTimeToUtc(date, endTime)
  if (endsAt <= startsAt) {
    const [y, m, d] = date.split('-').map(Number)
    const next = new Date(Date.UTC(y!, m! - 1, d! + 1))
    endsAt = clinicWallTimeToUtc(next.toISOString().slice(0, 10), endTime)
  }
  return { startsAt, endsAt }
}

export const GET = withAuth<{ id: string }>('shift:read', async (_req, ctx) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      requirements: true,
      claims: { include: { user: { select: { id: true, name: true, profession: true } } } },
    },
  })
  if (!shift) return errorResponse(createAppError('NOT_FOUND', 'That shift no longer exists.'))
  return NextResponse.json(shift)
})

export const PATCH = withAuth<{ id: string }>('shift:update', async (req, ctx) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const parsed = updateShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const { date, startTime, endTime, requirements, expectedVersion, mutationId } = parsed.data
  const proposed = { ...toInstants(date, startTime, endTime), requirements }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const result = dryRun
    ? await previewShiftEdit(prisma, shiftId, proposed)
    : await commitShiftEdit(prisma, shiftId, proposed, expectedVersion, mutationId)

  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})

export const DELETE = withAuth<{ id: string }>('shift:delete', async (req, ctx) => {
  const shiftId = parseId((await ctx.params).id)
  if (shiftId === null) return errorResponse(createAppError('INVALID_INPUT', 'Bad shift id.'))

  const url = new URL(req.url)
  if (url.searchParams.get('dryRun') === '1') {
    const preview = await previewShiftDelete(prisma, shiftId)
    if ('code' in preview) return errorResponse(preview)
    return NextResponse.json(preview)
  }

  const expectedVersion = Number(url.searchParams.get('expectedVersion'))
  if (!Number.isInteger(expectedVersion)) {
    return errorResponse(createAppError('INVALID_INPUT', 'expectedVersion is required.'))
  }

  const result = await commitShiftDelete(
    prisma, shiftId, expectedVersion,
    url.searchParams.get('mutationId') ?? undefined,
  )
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
```

Create `app/api/staff/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'

export const GET = withAuth('staff:read', async (req) => {
  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.user.findMany({
      ...args,
      where: { role: 'STAFF' },
      select: { id: true, name: true, email: true, profession: true },
    }),
  })

  return NextResponse.json(page)
})
```

Create `app/api/shifts/route.ts` (create + list):

```ts
import { NextResponse } from 'next/server'
import type { Profession } from '@prisma/client'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { createShiftSchema } from '@/lib/contracts/shifts'
import { createAppError } from '@/lib/domain/errors'
import { clinicWallTimeToUtc } from '@/lib/domain/time'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'

export const GET = withAuth('shift:read', async (req) => {
  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.shift.findMany({
      ...args,
      include: { requirements: true, _count: { select: { claims: true } } },
    }),
  })

  return NextResponse.json(page)
})

/** Expands a recurrence rule into the concrete dates it covers (§9). */
function occurrenceDates(from: string, weekdays: number[], until: string): string[] {
  const out: string[] = []
  const [fy, fm, fd] = from.split('-').map(Number)
  const cursor = new Date(Date.UTC(fy!, fm! - 1, fd!))
  const end = new Date(`${until}T00:00:00Z`)
  const wanted = new Set(weekdays)

  while (cursor <= end && out.length < 366) {
    if (wanted.has(cursor.getUTCDay())) out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

export const POST = withAuth('shift:create', async (req, ctx) => {
  const parsed = createShiftSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const { date, startTime, endTime, requirements, recurrence, mutationId } = parsed.data

  const dates = recurrence
    ? occurrenceDates(date, recurrence.weekdays, recurrence.untilDate)
    : [date]

  if (dates.length === 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That recurrence covers no dates.'))
  }

  const created = await prisma.$transaction(async (tx) => {
    const series = recurrence
      ? await tx.shiftSeries.create({
          data: {
            weekdays: recurrence.weekdays, startTime, endTime,
            untilDate: new Date(`${recurrence.untilDate}T00:00:00Z`),
            requirements,
          },
        })
      : null

    const ids: number[] = []
    for (const d of dates) {
      const startsAt = clinicWallTimeToUtc(d, startTime)
      let endsAt = clinicWallTimeToUtc(d, endTime)
      if (endsAt <= startsAt) {
        const [y, m, dd] = d.split('-').map(Number)
        const next = new Date(Date.UTC(y!, m! - 1, dd! + 1))
        endsAt = clinicWallTimeToUtc(next.toISOString().slice(0, 10), endTime)
      }

      const shift = await tx.shift.create({
        data: {
          startsAt, endsAt, seriesId: series?.id ?? null,
          requirements: {
            create: (Object.keys(requirements) as Profession[])
              .map((profession) => ({ profession, requiredCount: requirements[profession] })),
          },
        },
      })
      ids.push(shift.id)

      await emitEvent(tx, {
        topic: weekTopic(startsAt), type: 'shift.created',
        payload: { shiftId: shift.id, startsAt: startsAt.toISOString() },
        mutationId,
      })
    }
    return { ids, seriesId: series?.id ?? null }
  }, { timeout: 30_000 })

  return NextResponse.json(created, { status: 201 })
})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/contracts tests/api tests/rbac`
Expected: PASS. `tests/rbac/routes.test.ts` now finds route files and asserts each
exports handlers built by `withAuth`.

- [ ] **Step 8: Commit**

```bash
git add lib/contracts lib/db/paginate.ts app/api tests/contracts tests/api
git commit -m "feat: add shift and claim API with keyset pagination

Zod schemas are the only definition of each payload; types are inferred from
them on both sides. Claiming for another user resolves to claim:create:any, so
a staff member cannot assign anyone but themselves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Week coverage endpoint with compressed JSON

**Files:**
- Create: `lib/contracts/week.ts`, `lib/coverage.ts`, `app/api/weeks/[isoWeek]/route.ts`
- Test: `tests/contracts/week-codec.test.ts`, `tests/api/coverage.test.ts`

**Interfaces:**
- Consumes: `weekBounds` (Task 3), `withAuth` (Task 9), `paginate` is *not* used here (§6.4).
- Produces:
  - `type CoverageStatus = 'FULL' | 'PARTIAL' | 'EMPTY'`
  - `computeCoverage(requirements, claims): { status: CoverageStatus; missing: Record<Profession, number> }`
  - `encodeWeek(week: WeekView): CompressedWeek` / `decodeWeek(c: CompressedWeek): WeekView`
  - `GET /api/weeks/[isoWeek]` returning `CompressedWeek` with an `ETag`

- [ ] **Step 1: Write the codec and coverage test**

Create `tests/contracts/week-codec.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { decodeWeek, encodeWeek, type WeekView } from '@/lib/contracts/week'
import { computeCoverage } from '@/lib/coverage'

const view: WeekView = {
  isoWeek: '2026-W33',
  staff: [
    { id: 12, name: 'Ivy Bell', profession: 'NURSE' },
    { id: 3, name: 'Omar Patel', profession: 'DOCTOR' },
  ],
  shifts: [
    {
      id: 501, version: 2,
      startsAt: '2026-08-12T07:00:00.000Z', endsAt: '2026-08-12T15:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 },
      claimantIds: [12, 3],
    },
  ],
}

describe('week codec', () => {
  it('round-trips a week view unchanged', () => {
    expect(decodeWeek(encodeWeek(view))).toEqual(view)
  })

  it('mentions each staff name exactly once no matter how many shifts they hold', () => {
    const busy: WeekView = {
      ...view,
      shifts: Array.from({ length: 20 }, (_, i) => ({ ...view.shifts[0]!, id: 600 + i })),
    }
    const json = JSON.stringify(encodeWeek(busy))
    expect(json.split('Ivy Bell').length - 1).toBe(1)
  })

  it('is materially smaller than the uncompressed view', () => {
    const busy: WeekView = {
      ...view,
      shifts: Array.from({ length: 35 }, (_, i) => ({ ...view.shifts[0]!, id: 600 + i })),
    }
    const compressed = JSON.stringify(encodeWeek(busy)).length
    const plain = JSON.stringify(busy).length
    expect(compressed).toBeLessThan(plain * 0.6)
  })
})

describe('computeCoverage', () => {
  const req = { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 }

  it('is EMPTY with nobody claimed', () => {
    const c = computeCoverage(req, { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
    expect(c.status).toBe('EMPTY')
    expect(c.missing).toEqual({ DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 })
  })

  it('is PARTIAL with some roles filled and names what is missing', () => {
    const c = computeCoverage(req, { DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 })
    expect(c.status).toBe('PARTIAL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 })
  })

  it('is FULL when every requirement is met', () => {
    const c = computeCoverage(req, { DOCTOR: 1, NURSE: 3, RECEPTIONIST: 0 })
    expect(c.status).toBe('FULL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
  })

  it('never reports negative missing counts when over-staffed', () => {
    const c = computeCoverage(req, { DOCTOR: 2, NURSE: 5, RECEPTIONIST: 0 })
    expect(c.status).toBe('FULL')
    expect(c.missing).toEqual({ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/contracts/week-codec.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `coverage.ts`**

Create `lib/coverage.ts`:

```ts
import type { Profession } from '@prisma/client'

export type CoverageStatus = 'FULL' | 'PARTIAL' | 'EMPTY'

export interface Coverage {
  status: CoverageStatus
  /** How many more of each profession the shift still needs. Never negative. */
  missing: Record<Profession, number>
}

const PROFESSIONS: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']

/**
 * Single definition of a shift's staffing status, shared by the API, the week
 * grid and the shift detail page so the three can never disagree (§8.2).
 */
export function computeCoverage(
  requirements: Record<Profession, number>,
  claims: Record<Profession, number>,
): Coverage {
  const missing: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
  let filled = 0
  let required = 0

  for (const p of PROFESSIONS) {
    const need = requirements[p]
    const have = claims[p]
    missing[p] = Math.max(0, need - have)
    required += need
    filled += Math.min(need, have)
  }

  const status: CoverageStatus =
    filled === 0 ? 'EMPTY' : filled >= required ? 'FULL' : 'PARTIAL'

  return { status, missing }
}
```

- [ ] **Step 4: Implement the week codec**

Create `lib/contracts/week.ts`:

```ts
import { z } from 'zod'
import type { Profession } from '@prisma/client'

const PROFESSION_ORDER: Profession[] = ['DOCTOR', 'NURSE', 'RECEPTIONIST']

export interface WeekStaff { id: number; name: string; profession: Profession }

export interface WeekShift {
  id: number
  version: number
  startsAt: string
  endsAt: string
  requirements: Record<Profession, number>
  claimantIds: number[]
}

export interface WeekView {
  isoWeek: string
  staff: WeekStaff[]
  shifts: WeekShift[]
}

/**
 * Wire format (§6.2). Staff and profession names appear once per response
 * instead of once per claim, and shifts become positional tuples.
 *
 *   s: [[id, name, professionIndex], …]
 *   h: [[id, version, startsAt, endsAt, [dr, nu, re], [staffIndex, …]], …]
 *
 * The payload is not readable raw in devtools, which is why the encoder and
 * decoder live together here and are round-trip tested. No other endpoint uses
 * this encoding.
 */
export interface CompressedWeek {
  w: string
  p: Profession[]
  s: [number, string, number][]
  h: [number, number, string, string, [number, number, number], number[]][]
}

export function encodeWeek(view: WeekView): CompressedWeek {
  const staffIndex = new Map<number, number>()
  const s = view.staff.map((member, i) => {
    staffIndex.set(member.id, i)
    return [member.id, member.name, PROFESSION_ORDER.indexOf(member.profession)] as
      [number, string, number]
  })

  const h = view.shifts.map((shift) => [
    shift.id,
    shift.version,
    shift.startsAt,
    shift.endsAt,
    [shift.requirements.DOCTOR, shift.requirements.NURSE, shift.requirements.RECEPTIONIST] as
      [number, number, number],
    shift.claimantIds.map((id) => staffIndex.get(id) ?? -1).filter((i) => i >= 0),
  ] as CompressedWeek['h'][number])

  return { w: view.isoWeek, p: PROFESSION_ORDER, s, h }
}

export function decodeWeek(c: CompressedWeek): WeekView {
  const staff: WeekStaff[] = c.s.map(([id, name, p]) => ({
    id, name, profession: c.p[p]!,
  }))

  const shifts: WeekShift[] = c.h.map(([id, version, startsAt, endsAt, req, claimants]) => ({
    id, version, startsAt, endsAt,
    requirements: { DOCTOR: req[0], NURSE: req[1], RECEPTIONIST: req[2] },
    claimantIds: claimants.map((i) => staff[i]!.id),
  }))

  return { isoWeek: c.w, staff, shifts }
}

export const isoWeekParamSchema = z.string().regex(/^\d{4}-W\d{2}$/, 'Use YYYY-Www.')
```

- [ ] **Step 5: Implement the week route**

Create `app/api/weeks/[isoWeek]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { weekBounds } from '@/lib/domain/time'
import { encodeWeek, isoWeekParamSchema, type WeekShift, type WeekStaff } from '@/lib/contracts/week'

/**
 * A week is already a bounded window, so this endpoint is deliberately NOT
 * paginated (§6.4). It returns the compressed encoding plus an ETag, so
 * flipping back to an already-seen week costs a 304.
 */
export const GET = withAuth<{ isoWeek: string }>('shift:read', async (req, ctx) => {
  const { isoWeek } = await ctx.params
  const parsed = isoWeekParamSchema.safeParse(isoWeek)
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', 'Week must look like 2026-W33.'))
  }

  const { start, end } = weekBounds(parsed.data)

  const rows = await prisma.shift.findMany({
    where: { startsAt: { gte: start, lt: end } },
    orderBy: { startsAt: 'asc' },
    include: {
      requirements: true,
      claims: { include: { user: { select: { id: true, name: true, profession: true } } } },
    },
  })

  const staffById = new Map<number, WeekStaff>()
  const shifts: WeekShift[] = rows.map((shift) => {
    const requirements = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
    for (const r of shift.requirements) requirements[r.profession] = r.requiredCount

    const claimantIds: number[] = []
    for (const claim of shift.claims) {
      if (!claim.user.profession) continue
      staffById.set(claim.user.id, {
        id: claim.user.id, name: claim.user.name, profession: claim.user.profession,
      })
      claimantIds.push(claim.user.id)
    }

    return {
      id: shift.id, version: shift.version,
      startsAt: shift.startsAt.toISOString(), endsAt: shift.endsAt.toISOString(),
      requirements, claimantIds,
    }
  })

  const body = encodeWeek({ isoWeek: parsed.data, staff: [...staffById.values()], shifts })
  const payload = JSON.stringify(body)
  const etag = `W/"${createHash('sha1').update(payload).digest('base64url')}"`

  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  return new NextResponse(payload, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'private, no-cache' },
  })
})
```

- [ ] **Step 6: Write the coverage integration test**

Create `tests/api/coverage.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeWeek, encodeWeek, type WeekView } from '@/lib/contracts/week'
import { computeCoverage } from '@/lib/coverage'
import { assignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('week coverage over real data', () => {
  it('reports which roles are still missing after a partial claim', async () => {
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-12-01T09:00Z'), endsAt: new Date('2026-12-01T17:00Z'),
        requirements: { create: [
          { profession: 'NURSE', requiredCount: 2 },
          { profession: 'DOCTOR', requiredCount: 1 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ] },
      },
    })
    const nurse = await db.user.create({
      data: { email: 'n@c.test', name: 'N', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const claims = { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }
    const coverage = computeCoverage({ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }, claims)

    expect(coverage.status).toBe('PARTIAL')
    expect(coverage.missing).toEqual({ DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 })
  })

  it('survives an encode/decode round trip with real claim data', async () => {
    const view: WeekView = {
      isoWeek: '2026-W49',
      staff: [{ id: 1, name: 'N', profession: 'NURSE' }],
      shifts: [{
        id: 1, version: 0,
        startsAt: '2026-12-01T09:00:00.000Z', endsAt: '2026-12-01T17:00:00.000Z',
        requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
        claimantIds: [1],
      }],
    }
    expect(decodeWeek(encodeWeek(view))).toEqual(view)
  })
})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/contracts/week-codec.test.ts tests/api/coverage.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 8: Commit**

```bash
git add lib/coverage.ts lib/contracts/week.ts app/api/weeks tests/contracts tests/api
git commit -m "feat: add week coverage endpoint with dictionary-encoded payload

Staff names and profession labels appear once per response rather than once
per claim. computeCoverage is the single definition of full/partial/empty and
of which roles are missing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Realtime broadcast trigger, event replay and the import API

**Files:**
- Create: `prisma/migrations/<ts>_realtime_broadcast/migration.sql`, `app/api/events/since/route.ts`, `app/api/imports/route.ts`, `app/api/imports/[runId]/route.ts`, `lib/contracts/imports.ts`, `lib/contracts/events.ts`
- Test: `tests/api/imports.test.ts`, `tests/api/events.test.ts`

**Interfaces:**
- Consumes: `runStaffImport`/`runShiftImport`/`applyStaffImport`/`applyShiftImport` (Tasks 7–8), `paginate` (Task 12), `withAuth` (Task 9).
- Produces:
  - `GET /api/events/since?id=&topic=` → `{ events: OutboxEvent[]; lastId: string }`
  - `POST /api/imports` (multipart, `file` + `kind`) → `{ runId, stats }`
  - `GET /api/imports` (cursor) → run list
  - `GET /api/imports/[runId]` (cursor) → `{ run, rows, nextCursor }`

- [ ] **Step 1: Write the broadcast migration**

Create a migration with `npx prisma migrate dev --create-only --name realtime_broadcast`, then put this in its `migration.sql`:

```sql
-- Turn every outbox insert into a Supabase Realtime broadcast (§7.1).
-- Emitting from a trigger rather than from application code is what ties the
-- event to the transaction: a rolled-back mutation never broadcasts, and a
-- committed one always does.
CREATE OR REPLACE FUNCTION public.broadcast_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',         NEW.id::text,
      'type',       NEW.type,
      'payload',    NEW.payload,
      'mutationId', NEW."mutationId"
    ),
    NEW.type,
    NEW.topic,
    false               -- public channel; membership is already gated by app auth
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_broadcast
  AFTER INSERT ON "EventOutbox"
  FOR EACH ROW EXECUTE FUNCTION public.broadcast_outbox_event();
```

**Note for local/CI Postgres:** plain Postgres has no `realtime` schema, so the
trigger would fail. Guard it so tests and `docker compose` still work:

```sql
-- Only install the trigger where Supabase Realtime is present.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'realtime') THEN
    CREATE TRIGGER outbox_broadcast
      AFTER INSERT ON "EventOutbox"
      FOR EACH ROW EXECUTE FUNCTION public.broadcast_outbox_event();
  END IF;
END $$;
```

Replace the bare `CREATE TRIGGER` above with this guarded block. The outbox row
is written either way, so `GET /api/events/since` — and therefore replay and the
polling fallback — works identically without Supabase.

- [ ] **Step 2: Write the events replay test**

Create `tests/api/events.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

async function setup() {
  const db = await getTestDb()
  const shift = await db.shift.create({
    data: {
      startsAt: new Date('2026-12-01T09:00Z'), endsAt: new Date('2026-12-01T17:00Z'),
      requirements: { create: [
        { profession: 'NURSE', requiredCount: 3 },
        { profession: 'DOCTOR', requiredCount: 0 },
        { profession: 'RECEPTIONIST', requiredCount: 0 },
      ] },
    },
  })
  return { db, shift }
}

describe('event outbox replay', () => {
  it('assigns strictly increasing ids so a client can resume from its last seen', async () => {
    const { db, shift } = await setup()
    for (let i = 0; i < 3; i++) {
      const n = await db.user.create({
        data: { email: `n${i}@c.test`, name: `N${i}`, passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
      })
      await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id })
    }

    const all = await db.eventOutbox.findMany({ orderBy: { id: 'asc' } })
    expect(all).toHaveLength(3)
    const ids = all.map((e) => Number(e.id))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    const after = await db.eventOutbox.findMany({ where: { id: { gt: all[0]!.id } }, orderBy: { id: 'asc' } })
    expect(after).toHaveLength(2)
  })

  it('carries the mutationId through so the originator can drop its own echo', async () => {
    const { db, shift } = await setup()
    const n = await db.user.create({
      data: { email: 'n@c.test', name: 'N', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: n.id, actorId: n.id, mutationId: 'abcd1234efgh' })

    const event = await db.eventOutbox.findFirstOrThrow()
    expect(event.mutationId).toBe('abcd1234efgh')
    expect(event.topic).toBe('week:2026-W49')
  })

  it('writes no event when the mutation is rejected', async () => {
    const { db, shift } = await setup()
    const doctor = await db.user.create({
      data: { email: 'd@c.test', name: 'D', passwordHash: 'x', role: 'STAFF', profession: 'DOCTOR' },
    })
    const result = await assignClaim({ db, shiftId: shift.id, userId: doctor.id, actorId: doctor.id })

    expect('code' in result && result.code).toBe('PROFESSION_NOT_REQUIRED')
    expect(await db.eventOutbox.count()).toBe(0)
  })
})
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npm test -- tests/api/events.test.ts`
Expected: PASS, 3 tests. (`emitEvent` already exists from Task 10; this test pins the
guarantees the realtime layer depends on.)

- [ ] **Step 4: Implement the events endpoint**

Create `lib/contracts/events.ts`:

```ts
import { z } from 'zod'

export const eventsSinceQuerySchema = z.object({
  id: z.string().regex(/^\d+$/).default('0'),
  topic: z.string().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

export const outboxEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.record(z.unknown()),
  mutationId: z.string().nullable(),
})

export type OutboxEvent = z.infer<typeof outboxEventSchema>
```

Create `app/api/events/since/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { eventsSinceQuerySchema } from '@/lib/contracts/events'

/**
 * Replay for reconnecting clients (§7.1). Supabase Realtime broadcast is
 * at-most-once with no history, so a client that slept or dropped its socket
 * fetches the gap here rather than silently missing updates.
 */
export const GET = withAuth('shift:read', async (req) => {
  const url = new URL(req.url)
  const parsed = eventsSinceQuerySchema.safeParse({
    id: url.searchParams.get('id') ?? undefined,
    topic: url.searchParams.get('topic') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const rows = await prisma.eventOutbox.findMany({
    where: { topic: parsed.data.topic, id: { gt: BigInt(parsed.data.id) } },
    orderBy: { id: 'asc' },
    take: parsed.data.limit,
  })

  return NextResponse.json({
    events: rows.map((e) => ({
      id: e.id.toString(), type: e.type,
      payload: e.payload, mutationId: e.mutationId,
    })),
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id.toString() : parsed.data.id,
    /** True when the page was capped — the client should resync rather than assume it caught up. */
    truncated: rows.length === parsed.data.limit,
  })
})
```

- [ ] **Step 5: Implement the import API**

Create `lib/contracts/imports.ts`:

```ts
import { z } from 'zod'

export const importKindSchema = z.enum(['STAFF', 'SHIFT'])

export const importStatsSchema = z.object({
  accepted: z.number().int(),
  merged: z.number().int(),
  rejected: z.number().int(),
  total: z.number().int(),
})

export const importIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['REPAIR', 'FATAL']),
  message: z.string(),
  field: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
})

export const importRowSchema = z.object({
  id: z.number().int(),
  rowNumber: z.number().int(),
  rawRow: z.string(),
  outcome: z.enum(['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED']),
  issues: z.array(importIssueSchema),
})

export type ImportKind = z.infer<typeof importKindSchema>
export type ImportRowView = z.infer<typeof importRowSchema>
```

Create `app/api/imports/route.ts`:

```ts
import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { importKindSchema } from '@/lib/contracts/imports'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'

const MAX_BYTES = 2 * 1024 * 1024

export const GET = withAuth('import:read', async (req) => {
  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.importRun.findMany({
      ...args,
      select: {
        id: true, source: true, fileKind: true, filename: true,
        stats: true, createdAt: true,
        actor: { select: { name: true } },
      },
    }),
  })

  return NextResponse.json(page)
})

/**
 * Manager CSV upload. Runs the exact same engine as the seed (§5, §7.2) —
 * there is no separate "upload parser" that could drift from the seeded rules.
 */
export const POST = withAuth('import:run', async (req, ctx) => {
  const form = await req.formData().catch(() => null)
  if (!form) return errorResponse(createAppError('INVALID_INPUT', 'Expected a multipart upload.'))

  const file = form.get('file')
  const kindRaw = form.get('kind')

  if (!(file instanceof File)) {
    return errorResponse(createAppError('INVALID_INPUT', 'No file was uploaded.'))
  }
  if (file.size > MAX_BYTES) {
    return errorResponse(createAppError('INVALID_INPUT', 'File is larger than 2 MB.'))
  }

  const kind = importKindSchema.safeParse(kindRaw)
  if (!kind.success) {
    return errorResponse(createAppError('INVALID_INPUT', 'kind must be STAFF or SHIFT.'))
  }

  const text = await file.text()
  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD ?? 'medroster123', 10)
  const meta = {
    source: 'UPLOAD' as const,
    filename: file.name,
    actorId: ctx.principal.id,
    passwordHash,
  }

  const { runId, stats } = await prisma.$transaction(async (tx) => {
    if (kind.data === 'STAFF') {
      const result = runStaffImport(text)
      return { runId: await applyStaffImport(tx, result, meta), stats: result.stats }
    }
    const result = runShiftImport(text)
    return { runId: await applyShiftImport(tx, result, meta), stats: result.stats }
  }, { timeout: 60_000 })

  return NextResponse.json({ runId, stats }, { status: 201 })
})
```

Create `app/api/imports/[runId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'

export const GET = withAuth<{ runId: string }>('import:read', async (req, ctx) => {
  const runId = Number((await ctx.params).runId)
  if (!Number.isInteger(runId)) {
    return errorResponse(createAppError('INVALID_INPUT', 'Bad run id.'))
  }

  const run = await prisma.importRun.findUnique({
    where: { id: runId },
    select: {
      id: true, source: true, fileKind: true, filename: true,
      stats: true, createdAt: true, actor: { select: { name: true } },
    },
  })
  if (!run) return errorResponse(createAppError('NOT_FOUND', 'No such import run.'))

  const url = new URL(req.url)
  const { cursor, limit } = pageQuerySchema.parse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  const outcome = url.searchParams.get('outcome')

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.importRowResult.findMany({
      ...args,
      where: {
        importRunId: runId,
        ...(outcome && ['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED'].includes(outcome)
          ? { outcome: outcome as never } : {}),
      },
      select: { id: true, rowNumber: true, rawRow: true, outcome: true, issues: true },
    }),
  })

  return NextResponse.json({ run, ...page })
})
```

- [ ] **Step 6: Write the import API test**

Create `tests/api/imports.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runStaffImport } from '@/lib/import'
import { applyStaffImport } from '@/lib/import/apply'
import { paginate } from '@/lib/db/paginate'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('import report data', () => {
  it('pages through all 41 report rows without repeats', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const seen: number[] = []
    let cursor: string | null = null
    do {
      const page = await paginate({
        limit: 10, cursor,
        findMany: (args) => db.importRowResult.findMany({ ...args, where: { importRunId: runId } }),
      })
      seen.push(...page.items.map((r) => r.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(41)
    expect(new Set(seen).size).toBe(41)
  })

  it('can filter the report down to just the rejections', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const rejected = await db.importRowResult.findMany({
      where: { importRunId: runId, outcome: 'REJECTED' },
    })
    expect(rejected).toHaveLength(4)
    expect(rejected.map((r) => Number(r.rawRow.split(',')[0])).sort())
      .toEqual([995, 996, 997, 998])
  })

  it('stores the stats the run reported', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const run = await db.importRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.stats).toEqual({ accepted: 34, merged: 3, rejected: 4, total: 41 })
  })
})
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- tests/api`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/migrations app/api/events app/api/imports lib/contracts tests/api
git commit -m "feat: add realtime broadcast trigger, event replay and import API

The broadcast fires from a trigger on the outbox insert, so an event exists if
and only if its mutation committed. The trigger is guarded on the realtime
schema being present so plain Postgres in CI and Docker still works.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Seed — import plus deterministic claim seeding

**Files:**
- Create: `prisma/seed.ts`, `lib/seed/claim-seeder.ts`
- Test: `tests/seed/seed.test.ts`

**Interfaces:**
- Consumes: `runStaffImport`/`runShiftImport`/`apply*` (Tasks 7–8), `assignClaim` (Task 10).
- Produces:
  - `seedClaims(db, opts): Promise<{ attempted: number; created: number }>`
  - `createRng(seed: number): () => number` — deterministic, no `Math.random`
  - `npm run db:seed`

- [ ] **Step 1: Write the seed test**

Create `tests/seed/seed.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { createRng, seedClaims } from '@/lib/seed/claim-seeder'
import { computeCoverage } from '@/lib/coverage'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const META = { source: 'SEED' as const, filename: 'x.csv', passwordHash: 'x' }
const NOW = new Date('2026-07-28T00:00:00Z')

async function importFixtures() {
  const db = await getTestDb()
  await db.$transaction((tx) =>
    applyStaffImport(tx, runStaffImport(readFileSync('staff.csv', 'utf8')), META), { timeout: 60_000 })
  await db.$transaction((tx) =>
    applyShiftImport(tx, runShiftImport(readFileSync('shifts.csv', 'utf8')),
      { ...META, filename: 'shifts.csv' }), { timeout: 60_000 })
  return db
}

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('createRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(42), b = createRng(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('produces a different sequence for a different seed', () => {
    expect(createRng(1)()).not.toBe(createRng(2)())
  })

  it('stays within [0, 1)', () => {
    const r = createRng(7)
    for (let i = 0; i < 200; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('seedClaims', () => {
  it('creates claims that all satisfy the business rules', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.55, now: NOW })

    // No user may hold two overlapping shifts.
    const claims = await db.claim.findMany({ include: { shift: true } })
    const byUser = new Map<number, { startsAt: Date; endsAt: Date }[]>()
    for (const c of claims) {
      const list = byUser.get(c.userId) ?? []
      list.push(c.shift)
      byUser.set(c.userId, list)
    }
    for (const [, shifts] of byUser) {
      shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      for (let i = 1; i < shifts.length; i++) {
        expect(shifts[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(shifts[i - 1]!.endsAt.getTime())
      }
    }
  })

  it('never exceeds a shift\'s requirement for any profession', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.55, now: NOW })

    const shifts = await db.shift.findMany({
      include: { requirements: true, claims: { include: { user: true } } },
    })
    for (const shift of shifts) {
      for (const req of shift.requirements) {
        const held = shift.claims.filter((c) => c.user.profession === req.profession).length
        expect(held, `shift ${shift.id} ${req.profession}`).toBeLessThanOrEqual(req.requiredCount)
      }
    }
  })

  it('is deterministic — the same seed yields the same claim set', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.55, now: NOW })
    const first = (await db.claim.findMany({ orderBy: [{ shiftId: 'asc' }, { userId: 'asc' }] }))
      .map((c) => `${c.shiftId}:${c.userId}`)

    await db.claim.deleteMany({})
    await seedClaims(db, { seed: 1337, fillRatio: 0.55, now: NOW })
    const second = (await db.claim.findMany({ orderBy: [{ shiftId: 'asc' }, { userId: 'asc' }] }))
      .map((c) => `${c.shiftId}:${c.userId}`)

    expect(second).toEqual(first)
  })

  it('produces all three coverage states so the dashboard demonstrates each', async () => {
    const db = await importFixtures()
    await seedClaims(db, { seed: 1337, fillRatio: 0.55, now: NOW })

    const shifts = await db.shift.findMany({
      include: { requirements: true, claims: { include: { user: true } } },
    })
    const statuses = new Set(shifts.map((shift) => {
      const req = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
      for (const r of shift.requirements) req[r.profession] = r.requiredCount
      const have = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
      for (const c of shift.claims) if (c.user.profession) have[c.user.profession] += 1
      return computeCoverage(req, have).status
    }))

    expect(statuses).toContain('FULL')
    expect(statuses).toContain('PARTIAL')
    expect(statuses).toContain('EMPTY')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/seed/seed.test.ts`
Expected: FAIL — `@/lib/seed/claim-seeder` not found.

- [ ] **Step 3: Implement the claim seeder**

Create `lib/seed/claim-seeder.ts`:

```ts
import type { PrismaClient } from '@prisma/client'
import { assignClaim } from '@/lib/rules/assign'

/** Mulberry32 — small, fast, fully deterministic. No Math.random anywhere in the seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export interface SeedClaimsOptions {
  seed: number
  /** Roughly what fraction of open slots to attempt to fill. */
  fillRatio: number
  now?: Date
}

/**
 * Populates the roster with claims so the coverage dashboard shows all three
 * states rather than a wall of empty shifts (§7.2).
 *
 * Every claim goes through assignClaim — the same validator and the same locks
 * a real staff member hits. Nothing is written directly, so this doubles as an
 * end-to-end exercise of the rules engine and cannot produce a roster the
 * application itself would consider invalid.
 */
export async function seedClaims(
  db: PrismaClient,
  opts: SeedClaimsOptions,
): Promise<{ attempted: number; created: number }> {
  const rng = createRng(opts.seed)
  const now = opts.now ?? new Date()

  const shifts = await db.shift.findMany({
    where: { startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    include: { requirements: true },
  })

  const staff = await db.user.findMany({
    where: { role: 'STAFF' },
    orderBy: { id: 'asc' },
    select: { id: true, profession: true },
  })

  const byProfession = new Map<string, number[]>()
  for (const person of staff) {
    if (!person.profession) continue
    const list = byProfession.get(person.profession) ?? []
    list.push(person.id)
    byProfession.set(person.profession, list)
  }

  let attempted = 0
  let created = 0

  // Shuffled shift order means the filled shifts are scattered across the month
  // rather than front-loaded, so any week the reviewer lands on shows a mix.
  for (const shift of shuffle(shifts, rng)) {
    for (const requirement of shift.requirements) {
      if (requirement.requiredCount === 0) continue

      const pool = byProfession.get(requirement.profession) ?? []
      if (pool.length === 0) continue

      // Vary how full each shift gets: some reach FULL, most land PARTIAL,
      // and the shifts skipped entirely stay EMPTY.
      const target = Math.round(requirement.requiredCount * (opts.fillRatio + rng() * 0.6))
      const wanted = Math.min(requirement.requiredCount, Math.max(0, target))

      for (const userId of shuffle(pool, rng).slice(0, wanted)) {
        attempted += 1
        // Rejections are expected and fine — the roster is deliberately
        // over-subscribed, so many candidates already hold an overlapping shift.
        const result = await assignClaim({ db, shiftId: shift.id, userId, actorId: userId, now })
        if ('claimId' in result) created += 1
      }
    }
  }

  return { attempted, created }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/seed/seed.test.ts`
Expected: PASS, 7 tests.

If the "all three coverage states" test fails, tune `fillRatio` — not the test. At
`0.55` some shifts should reach FULL while the deliberate 388-slots-vs-34-staff
shortage (§2.3) guarantees plenty of PARTIAL and EMPTY.

- [ ] **Step 5: Implement `prisma/seed.ts`**

Create `prisma/seed.ts`:

```ts
import { readFileSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { seedClaims } from '@/lib/seed/claim-seeder'

const prisma = new PrismaClient()

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10)

  // Idempotent: upserts keyed on the CSV ids mean re-running never duplicates.
  await prisma.user.upsert({
    where: { email: 'manager@clinicmail.test' },
    create: {
      email: 'manager@clinicmail.test', name: 'Dana Okonkwo',
      passwordHash, role: 'MANAGER',
    },
    update: { passwordHash },
  })

  const staffResult = runStaffImport(readFileSync('staff.csv', 'utf8'))
  await prisma.$transaction((tx) =>
    applyStaffImport(tx, staffResult, {
      source: 'SEED', filename: 'staff.csv', passwordHash,
    }), { timeout: 60_000 })

  const shiftResult = runShiftImport(readFileSync('shifts.csv', 'utf8'))
  await prisma.$transaction((tx) =>
    applyShiftImport(tx, shiftResult, {
      source: 'SEED', filename: 'shifts.csv', passwordHash,
    }), { timeout: 120_000 })

  console.log('staff  ', staffResult.stats)
  console.log('shifts ', shiftResult.stats)

  const existingClaims = await prisma.claim.count()
  if (existingClaims === 0) {
    const { attempted, created } = await seedClaims(prisma, { seed: 1337, fillRatio: 0.55 })
    console.log(`claims  attempted ${attempted}, created ${created}`)
  } else {
    console.log(`claims  ${existingClaims} already present, skipping claim seeding`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
```

Add `tsx` and wire the Prisma seed hook in `package.json`:

```bash
npm i -D tsx
```

```json
{ "prisma": { "seed": "tsx prisma/seed.ts" } }
```

- [ ] **Step 6: Run the seed against the local database**

```bash
docker compose up -d db
npx dotenv -e .env -- npx prisma migrate deploy
npx dotenv -e .env -- npx tsx prisma/seed.ts
```

Expected output:

```
staff   { accepted: 34, merged: 3, rejected: 4, total: 41 }
shifts  { accepted: 109, merged: 2, rejected: 6, total: 117 }
claims  attempted NNN, created NNN
```

- [ ] **Step 7: Commit**

```bash
git add prisma/seed.ts lib/seed tests/seed package.json
git commit -m "feat: seed the roster via the importer and a deterministic claim pass

Seeded claims go through assignClaim, so the seed exercises the real validator
and cannot produce a roster the app would consider invalid. A fixed RNG makes
the result reproducible across deploys.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Design system — Pencil mockups and tokens

**Files:**
- Create: `design/medroster.pen`, `app/globals.css` (modify), `tailwind.config.ts` (modify), `lib/ui/tokens.ts`
- Test: `tests/ui/tokens.test.ts`

**Interfaces:**
- Consumes: the palette in §8.1.
- Produces: CSS custom properties, Tailwind theme extension, and `STATUS_STYLES: Record<CoverageStatus, { label: string; dot: string; chip: string }>` used by every status display.

> This task is design-first. Produce the mockups **before** writing any component
> code, so the UI tasks implement a decided design rather than inventing one.

- [ ] **Step 1: Load the Pencil schema and guidelines**

Call `mcp__pencil__get_editor_state` with `include_schema: true`, then
`mcp__pencil__get_guidelines`. Do not call any other Pencil tool before this —
the schema is required to construct valid nodes.

- [ ] **Step 2: Create the design file and define variables**

Create `design/medroster.pen` via `mcp__pencil__batch_design`. Define these
variables first so every frame references tokens rather than literals:

```
brand/primary      #0D9488
brand/mid          #5EEAD4
brand/deep         #0F766E
surface/tint       #ECFDF8
surface/base       #FFFFFF
surface/raised     #F8FAFC
ink/strong         #0F172A
ink/muted          #64748B
status/full        #059669
status/partial     #D97706
status/empty       #E11D48
radius/card        16
radius/pill        999
```

Status colours deliberately sit outside the brand family (§8.1) so "partially
staffed" amber never reads as brand chrome.

- [ ] **Step 3: Design the five frames**

Produce these frames at 1440×N desktop, plus 390×N mobile variants for the two
marked responsive:

1. **Landing** — gradient hero (brand/mid → brand/primary → brand/deep), headline
   "Shifts That Staff Themselves", subhead, primary CTA, and a floating dashboard
   card overlapping the hero's lower edge showing a miniature week grid. Below:
   three feature cards, then an FAQ accordion.
2. **Dashboard week grid** *(responsive)* — 7 day columns, shift cards stacked
   within each. Each card: time range, a status dot, and the missing-roles chip
   row ("needs 2 nurses, 1 doctor"). Header carries prev/next week, a date
   picker, and a "Today" button.
3. **Shift detail** — time, requirements as filled/total per profession, the
   claimant list, a claim button, and the manager's edit/delete actions.
4. **Edit drop-preview dialog** — the proposed change summarised, then an
   explicit list of who will be dropped and why, with confirm/cancel.
5. **Import report** — the four outcome counts as stat tiles, then a filterable
   row table: raw row in monospace, outcome chip, and the issue list showing
   before → after.

- [ ] **Step 4: Screenshot each frame and review**

Call `mcp__pencil__get_screenshot` per frame. Check: does the week grid stay
legible at 390px? Are the three status states distinguishable without relying on
colour alone (each has a distinct dot glyph as well as hue)? Is the missing-roles
text readable at card size?

Present the screenshots to the user before proceeding to Step 5.

- [ ] **Step 5: Write the tokens test**

Create `tests/ui/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { STATUS_STYLES } from '@/lib/ui/tokens'

describe('STATUS_STYLES', () => {
  it('covers every coverage status', () => {
    expect(Object.keys(STATUS_STYLES).sort()).toEqual(['EMPTY', 'FULL', 'PARTIAL'])
  })

  it('gives each status a distinct label and glyph, so colour is not the only signal', () => {
    const labels = Object.values(STATUS_STYLES).map((s) => s.label)
    const glyphs = Object.values(STATUS_STYLES).map((s) => s.glyph)
    expect(new Set(labels).size).toBe(3)
    expect(new Set(glyphs).size).toBe(3)
  })
})
```

- [ ] **Step 6: Implement the tokens**

Create `lib/ui/tokens.ts`:

```ts
import type { CoverageStatus } from '@/lib/coverage'

/**
 * The single definition of how a staffing status looks and reads. Every badge,
 * dot and legend pulls from here, so the week grid and the shift detail page
 * cannot drift apart.
 *
 * Each status carries a distinct glyph as well as a distinct hue — status must
 * survive being read in greyscale or by a colour-blind user.
 */
export const STATUS_STYLES: Record<CoverageStatus, {
  label: string
  glyph: string
  dot: string
  chip: string
}> = {
  FULL: {
    label: 'Fully staffed', glyph: '●',
    dot: 'bg-emerald-600',
    chip: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  },
  PARTIAL: {
    label: 'Partially staffed', glyph: '◐',
    dot: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-900',
  },
  EMPTY: {
    label: 'Unstaffed', glyph: '○',
    dot: 'bg-rose-600',
    chip: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900',
  },
}
```

Add to `app/globals.css`:

```css
@theme {
  --color-brand-primary: #0D9488;
  --color-brand-mid: #5EEAD4;
  --color-brand-deep: #0F766E;
  --color-surface-tint: #ECFDF8;
  --radius-card: 1rem;
}

.hero-gradient {
  background: linear-gradient(160deg, var(--color-brand-mid) 0%, var(--color-brand-primary) 45%, var(--color-brand-deep) 100%);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- tests/ui/tokens.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Commit**

```bash
git add design lib/ui app/globals.css tailwind.config.ts tests/ui
git commit -m "feat: add teal design tokens and Pencil mockups

Status styles carry a distinct glyph as well as a hue so staffing state
survives greyscale and colour-blind reading. Status colours sit outside the
brand family so amber never reads as brand chrome.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: UI foundation — layout, skeletons, landing, login

**Files:**
- Create: `components/ui/*` (shadcn), `components/skeletons/index.tsx`, `components/app-shell.tsx`, `app/(marketing)/page.tsx`, `app/login/page.tsx`, `app/(app)/layout.tsx`
- Test: `tests/ui/skeletons.test.tsx`

**Interfaces:**
- Consumes: `STATUS_STYLES` (Task 16), `ROLE_PERMISSIONS`/`can` (Task 9), `signIn` (Task 9).
- Produces: `<AppShell>`, `<WeekGridSkeleton>`, `<ShiftCardSkeleton>`, `<ImportReportSkeleton>`, `<StatDot status>`.

- [ ] **Step 1: Install the shadcn primitives**

```bash
npx shadcn@latest init -d
npx shadcn@latest add button card dialog input select table badge skeleton \
  dropdown-menu tabs accordion sonner
```

- [ ] **Step 2: Write the skeleton test**

Create `tests/ui/skeletons.test.tsx` (add `environment: 'jsdom'` via a docblock):

```tsx
/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShiftCardSkeleton, WeekGridSkeleton } from '@/components/skeletons'

describe('skeletons', () => {
  it('renders one column per weekday so the grid does not reflow on load', () => {
    const { container } = render(<WeekGridSkeleton />)
    expect(container.querySelectorAll('[data-skeleton-day]')).toHaveLength(7)
  })

  it('marks itself busy for assistive technology', () => {
    render(<ShiftCardSkeleton />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
  })
})
```

Install the test deps:

```bash
npm i -D jsdom @testing-library/react @testing-library/jest-dom @vitejs/plugin-react
```

Add `@vitejs/plugin-react` to `vitest.config.ts` plugins and include `tests/**/*.test.tsx`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- tests/ui/skeletons.test.tsx`
Expected: FAIL — `@/components/skeletons` not found.

- [ ] **Step 4: Implement the skeletons**

Create `components/skeletons/index.tsx`:

```tsx
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Skeletons are built from the same layout primitives and the same fixed
 * dimensions as the real components (§8.4), so hydration swaps content in
 * without shifting anything on the page.
 */
export function ShiftCardSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading shift"
         className="rounded-card border bg-card p-3 space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-3 w-32" />
      <div className="flex gap-1.5 pt-1">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
    </div>
  )
}

export function WeekGridSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-7">
      {Array.from({ length: 7 }, (_, day) => (
        <div key={day} data-skeleton-day className="space-y-3">
          <Skeleton className="h-4 w-20" />
          {Array.from({ length: 3 }, (_, i) => <ShiftCardSkeleton key={i} />)}
        </div>
      ))}
    </div>
  )
}

export function ImportReportSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-14 w-full" />)}
    </div>
  )
}
```

- [ ] **Step 5: Implement the landing page**

Create `app/(marketing)/page.tsx` implementing the Task 16 Frame 1 mockup: hero
with `.hero-gradient`, headline "Shifts That Staff Themselves", subhead naming the
real value ("Managers post the rota. Staff claim what fits. The rules are enforced
server-side, so double-bookings never happen."), a primary CTA to `/login`, and a
floating dashboard card overlapping the hero's lower edge. Below it, three feature
cards (coverage at a glance, rules that hold under load, spreadsheet import that
shows its work) and an FAQ accordion.

Keep it a server component — no client JS beyond the accordion.

- [ ] **Step 6: Implement login**

Create `app/login/page.tsx` — a server component rendering a client form that calls
`signIn('credentials', { email, password, redirectTo: next ?? '/dashboard' })`,
surfacing the error inline on failure. Include a small "demo accounts" card listing
the seeded manager and one staff member per profession, each with a click-to-fill
button — a reviewer should not have to leave the page to find credentials.

- [ ] **Step 7: Implement the app shell**

Create `components/app-shell.tsx` — header with the MedRoster mark, nav links
filtered through `can(principal, …)` so a staff member never sees Import or
New Shift, and a user menu with sign-out. Create `app/(app)/layout.tsx` wrapping
children in it, reading the session server-side.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- tests/ui`
Expected: PASS.

- [ ] **Step 9: Verify visually**

```bash
npm run dev
```

Open `http://localhost:3000` and `http://localhost:3000/login`. Confirm the hero
gradient matches the Task 16 mockup and the demo-account fill buttons work.

- [ ] **Step 10: Commit**

```bash
git add components app/\(marketing\) app/login app/\(app\) tests/ui
git commit -m "feat: add app shell, skeletons, landing page and login

Nav links are filtered through the same permission catalog the API enforces,
so a staff member is never shown a control that would 403. Skeletons reuse the
real components' dimensions to avoid layout shift on hydration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Coverage dashboard — responsive week grid with jump-to-week

**Files:**
- Create: `app/(app)/dashboard/page.tsx`, `components/week-grid/week-grid.tsx`, `components/week-grid/shift-card.tsx`, `components/week-grid/week-picker.tsx`, `hooks/use-week.ts`
- Test: `tests/ui/week-grid.test.tsx`

**Interfaces:**
- Consumes: `GET /api/weeks/[isoWeek]` + `decodeWeek` (Task 13), `computeCoverage` (Task 13), `STATUS_STYLES` (Task 16), `WeekGridSkeleton` (Task 17).
- Produces: `<WeekGrid week={WeekView} />`, `<ShiftCard shift coverage />`, `<WeekPicker value onChange />`.

- [ ] **Step 1: Write the week grid test**

Create `tests/ui/week-grid.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ShiftCard } from '@/components/week-grid/shift-card'
import { WeekGrid } from '@/components/week-grid/week-grid'
import type { WeekView } from '@/lib/contracts/week'

const view: WeekView = {
  isoWeek: '2026-W33',
  staff: [{ id: 1, name: 'Ivy Bell', profession: 'NURSE' }],
  shifts: [
    { id: 1, version: 0, startsAt: '2026-08-10T07:00:00.000Z', endsAt: '2026-08-10T15:00:00.000Z',
      requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }, claimantIds: [1] },
    { id: 2, version: 0, startsAt: '2026-08-11T07:00:00.000Z', endsAt: '2026-08-11T15:00:00.000Z',
      requirements: { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }, claimantIds: [] },
  ],
}

describe('ShiftCard', () => {
  it('names exactly which roles are still missing', () => {
    render(<ShiftCard
      shift={view.shifts[0]!}
      claims={{ DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }} />)
    expect(screen.getByText(/1 nurse/i)).toBeInTheDocument()
    expect(screen.getByText(/1 doctor/i)).toBeInTheDocument()
  })

  it('says nothing is missing when fully staffed', () => {
    render(<ShiftCard
      shift={view.shifts[0]!}
      claims={{ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }} />)
    expect(screen.getByText(/fully staffed/i)).toBeInTheDocument()
  })

  it('labels status in text as well as colour', () => {
    render(<ShiftCard shift={view.shifts[1]!} claims={{ DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }} />)
    expect(screen.getByText(/unstaffed/i)).toBeInTheDocument()
  })
})

describe('WeekGrid', () => {
  it('renders all seven days even when some have no shifts', () => {
    render(<WeekGrid week={view} />)
    expect(screen.getAllByRole('group', { name: /day column/i })).toHaveLength(7)
  })

  it('places each shift under its own day', () => {
    render(<WeekGrid week={view} />)
    const monday = screen.getByRole('group', { name: /monday/i })
    expect(within(monday).getAllByRole('article')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/ui/week-grid.test.tsx`
Expected: FAIL — components not found.

- [ ] **Step 3: Implement `shift-card.tsx`**

Create `components/week-grid/shift-card.tsx`:

```tsx
import Link from 'next/link'
import type { Profession } from '@prisma/client'
import { computeCoverage } from '@/lib/coverage'
import { PROFESSION_LABELS } from '@/lib/domain/profession'
import { STATUS_STYLES } from '@/lib/ui/tokens'
import type { WeekShift } from '@/lib/contracts/week'

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', timeZone: process.env.NEXT_PUBLIC_CLINIC_TZ ?? 'Europe/London',
})

function missingLabel(missing: Record<Profession, number>): string {
  const parts = (Object.keys(missing) as Profession[])
    .filter((p) => missing[p] > 0)
    .map((p) => {
      const n = missing[p]
      const label = PROFESSION_LABELS[p].toLowerCase()
      return `${n} ${label}${n === 1 ? '' : 's'}`
    })
  return parts.join(', ')
}

export function ShiftCard({ shift, claims }: {
  shift: WeekShift
  claims: Record<Profession, number>
}) {
  const { status, missing } = computeCoverage(shift.requirements, claims)
  const style = STATUS_STYLES[status]

  return (
    <article className="rounded-card border bg-card p-3 transition hover:shadow-md focus-within:ring-2 focus-within:ring-brand-primary">
      <Link href={`/shifts/${shift.id}`} className="block space-y-2 outline-none">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium tabular-nums">
            {clock.format(new Date(shift.startsAt))}–{clock.format(new Date(shift.endsAt))}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${style.chip}`}>
            <span aria-hidden>{style.glyph}</span>
            {style.label}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">
          {status === 'FULL'
            ? 'Fully staffed'
            : <>Still needs <span className="font-medium text-foreground">{missingLabel(missing)}</span></>}
        </p>
      </Link>
    </article>
  )
}
```

- [ ] **Step 4: Implement `week-grid.tsx`**

Create `components/week-grid/week-grid.tsx`:

```tsx
import type { Profession } from '@prisma/client'
import { weekBounds } from '@/lib/domain/time'
import type { WeekView } from '@/lib/contracts/week'
import { ShiftCard } from './shift-card'

const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
const dayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Seven columns on desktop, a stacked day list under md (§8.2). Status and the
 * missing-roles line stay visible at every width — the grid narrows, it does not
 * drop information.
 */
export function WeekGrid({ week }: { week: WeekView }) {
  const { start } = weekBounds(week.isoWeek)

  const professionOf = new Map(week.staff.map((s) => [s.id, s.profession]))

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(start)
    dayStart.setDate(start.getDate() + i)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayStart.getDate() + 1)

    return {
      date: dayStart,
      shifts: week.shifts.filter((s) => {
        const at = new Date(s.startsAt)
        return at >= dayStart && at < dayEnd
      }),
    }
  })

  return (
    <div className="grid gap-4 md:grid-cols-7">
      {days.map((day) => (
        <section
          key={day.date.toISOString()}
          role="group"
          aria-label={`Day column, ${dayName.format(day.date)}`}
          className="space-y-3"
        >
          <h3 className="sticky top-0 z-10 bg-background/90 pb-1 text-sm font-semibold backdrop-blur">
            {dayShort.format(day.date)}
          </h3>

          {day.shifts.length === 0 ? (
            <p className="rounded-card border border-dashed p-3 text-xs text-muted-foreground">
              No shifts
            </p>
          ) : (
            day.shifts.map((shift) => {
              const claims: Record<Profession, number> = { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }
              for (const id of shift.claimantIds) {
                const p = professionOf.get(id)
                if (p) claims[p] += 1
              }
              return <ShiftCard key={shift.id} shift={shift} claims={claims} />
            })
          )}
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Implement the week picker and dashboard page**

Create `components/week-grid/week-picker.tsx` — a client component with
**Previous / Today / Next** buttons plus a native date input that maps the chosen
date to its ISO week via `isoWeekOf`, satisfying the brief's "way to jump to any
week". It pushes `?week=YYYY-Www` onto the URL so the view is linkable and the
back button works.

Create `app/(app)/dashboard/page.tsx` — a server component that reads
`searchParams.week` (defaulting to the current week), fetches the week server-side,
and renders `<WeekGrid>` inside `<Suspense fallback={<WeekGridSkeleton />}>`. Include
a legend row mapping each glyph and colour to its label.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/ui/week-grid.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 7: Verify responsiveness**

```bash
npm run dev
```

Open `/dashboard?week=2026-W33` at 1440px, 768px and 390px. At 390px the grid must
stack to one column per day with status and missing roles still legible — the brief
states this view is checked for responsiveness.

- [ ] **Step 8: Commit**

```bash
git add app/\(app\)/dashboard components/week-grid tests/ui/week-grid.test.tsx
git commit -m "feat: add responsive coverage dashboard with jump-to-week

Each card names the specific roles still missing rather than only showing a
status colour. The week lives in the URL so views are linkable and the back
button works.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Interactions — optimistic claiming, realtime, shift forms, import UI

**Files:**
- Create: `hooks/use-realtime.ts`, `hooks/use-optimistic-claim.ts`, `app/(app)/shifts/[id]/page.tsx`, `components/shift/claim-button.tsx`, `components/shift/edit-dialog.tsx`, `app/(app)/shifts/new/page.tsx`, `app/(app)/my-shifts/page.tsx`, `app/(app)/import/page.tsx`, `app/(app)/import/[runId]/page.tsx`
- Test: `tests/ui/optimistic.test.tsx`, `tests/ui/realtime.test.ts`

**Interfaces:**
- Consumes: every API route from Tasks 12–14; `decodeWeek` (Task 13); `STATUS_STYLES` (Task 16).
- Produces:
  - `useRealtimeWeek(isoWeek, { onEvent }): { connected: boolean }`
  - `useOptimisticClaim(shiftId): { claim, release, pending, error }`
  - `newMutationId(): string`

- [ ] **Step 1: Write the realtime reconciliation test**

Create `tests/ui/realtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyEvent, newMutationId, shouldApply } from '@/hooks/use-realtime'

describe('newMutationId', () => {
  it('is long enough to be unique and satisfies the contract', () => {
    const id = newMutationId()
    expect(id.length).toBeGreaterThanOrEqual(8)
    expect(newMutationId()).not.toBe(id)
  })
})

describe('shouldApply', () => {
  it('drops the originator\'s own echo, which was already applied optimistically', () => {
    const mine = new Set(['abc12345'])
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: 'abc12345' }, mine)).toBe(false)
  })

  it('applies an event from another user', () => {
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: 'other999' }, new Set())).toBe(true)
  })

  it('applies an event with no mutation id', () => {
    expect(shouldApply({ id: '5', type: 'shift.claimed', payload: {}, mutationId: null }, new Set())).toBe(true)
  })
})

describe('applyEvent', () => {
  const week = {
    isoWeek: '2026-W33',
    staff: [{ id: 1, name: 'Ivy', profession: 'NURSE' as const }],
    shifts: [{
      id: 10, version: 0, startsAt: '2026-08-10T07:00:00.000Z', endsAt: '2026-08-10T15:00:00.000Z',
      requirements: { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 0 }, claimantIds: [],
    }],
  }

  it('adds a claimant on shift.claimed', () => {
    const next = applyEvent(week, {
      id: '1', type: 'shift.claimed', mutationId: null,
      payload: { shiftId: 10, userId: 2, name: 'Omar', profession: 'NURSE' },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([2])
    expect(next.staff.find((s) => s.id === 2)?.name).toBe('Omar')
  })

  it('removes a claimant on shift.unclaimed', () => {
    const seeded = { ...week, shifts: [{ ...week.shifts[0]!, claimantIds: [1] }] }
    const next = applyEvent(seeded, {
      id: '2', type: 'shift.unclaimed', mutationId: null, payload: { shiftId: 10, userId: 1 },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([])
  })

  it('removes every dropped claimant on shift.claims_dropped', () => {
    const seeded = { ...week, shifts: [{ ...week.shifts[0]!, claimantIds: [1, 2] }] }
    const next = applyEvent(seeded, {
      id: '3', type: 'shift.claims_dropped', mutationId: null,
      payload: { shiftId: 10, dropped: [{ userId: 1 }, { userId: 2 }] },
    })
    expect(next.shifts[0]!.claimantIds).toEqual([])
  })

  it('drops the shift entirely on shift.deleted', () => {
    const next = applyEvent(week, {
      id: '4', type: 'shift.deleted', mutationId: null, payload: { shiftId: 10 },
    })
    expect(next.shifts).toHaveLength(0)
  })

  it('leaves the view untouched for an unknown event type', () => {
    expect(applyEvent(week, { id: '5', type: 'nonsense', mutationId: null, payload: {} })).toEqual(week)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/ui/realtime.test.ts`
Expected: FAIL — `@/hooks/use-realtime` not found.

- [ ] **Step 3: Implement `use-realtime.ts`**

Create `hooks/use-realtime.ts`:

```ts
'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import type { OutboxEvent } from '@/lib/contracts/events'
import type { WeekView } from '@/lib/contracts/week'

export function newMutationId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * An event the caller originated has already been applied optimistically, so
 * replaying it would flicker. Everyone else's events apply normally (§7.1).
 */
export function shouldApply(event: OutboxEvent, ownMutationIds: Set<string>): boolean {
  return !event.mutationId || !ownMutationIds.has(event.mutationId)
}

/** Pure reducer, so the reconciliation rules are testable without a socket. */
export function applyEvent(week: WeekView, event: OutboxEvent): WeekView {
  const p = event.payload as Record<string, never>
  const shiftId = Number(p.shiftId)

  switch (event.type) {
    case 'shift.claimed': {
      const userId = Number(p.userId)
      const staff = week.staff.some((s) => s.id === userId)
        ? week.staff
        : [...week.staff, { id: userId, name: String(p.name), profession: p.profession }]
      return {
        ...week, staff,
        shifts: week.shifts.map((s) =>
          s.id === shiftId && !s.claimantIds.includes(userId)
            ? { ...s, claimantIds: [...s.claimantIds, userId] }
            : s),
      }
    }
    case 'shift.unclaimed': {
      const userId = Number(p.userId)
      return {
        ...week,
        shifts: week.shifts.map((s) =>
          s.id === shiftId ? { ...s, claimantIds: s.claimantIds.filter((id) => id !== userId) } : s),
      }
    }
    case 'shift.claims_dropped': {
      const dropped = new Set((p.dropped as unknown as { userId: number }[]).map((d) => d.userId))
      return {
        ...week,
        shifts: week.shifts.map((s) =>
          s.id === shiftId ? { ...s, claimantIds: s.claimantIds.filter((id) => !dropped.has(id)) } : s),
      }
    }
    case 'shift.deleted':
      return { ...week, shifts: week.shifts.filter((s) => s.id !== shiftId) }
    default:
      return week
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
)

export function useRealtimeWeek(
  isoWeek: string,
  handlers: { onEvent: (e: OutboxEvent) => void; onResync: () => void },
): { connected: boolean } {
  const [connected, setConnected] = useState(false)
  const lastIdRef = useRef('0')
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    const topic = `week:${isoWeek}`
    let channel: RealtimeChannel | undefined
    let cancelled = false

    /** Fetches everything missed since lastId — broadcast has no history (§7.1). */
    async function catchUp() {
      const res = await fetch(
        `/api/events/since?topic=${encodeURIComponent(topic)}&id=${lastIdRef.current}`)
      if (!res.ok || cancelled) return
      const body = await res.json() as { events: OutboxEvent[]; lastId: string; truncated: boolean }

      if (body.truncated) {
        // Too far behind to reconcile event-by-event; refetch rather than diverge.
        lastIdRef.current = body.lastId
        handlersRef.current.onResync()
        return
      }
      for (const event of body.events) handlersRef.current.onEvent(event)
      lastIdRef.current = body.lastId
    }

    channel = supabase
      .channel(topic, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: '*' }, ({ payload }) => {
        const event = payload as OutboxEvent
        if (Number(event.id) <= Number(lastIdRef.current)) return // already seen
        lastIdRef.current = event.id
        handlersRef.current.onEvent(event)
      })
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
        if (status === 'SUBSCRIBED') void catchUp()
      })

    // A tab woken from sleep may have missed everything; reconcile on focus.
    const onVisible = () => { if (document.visibilityState === 'visible') void catchUp() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [isoWeek])

  return { connected }
}
```

- [ ] **Step 4: Write the optimistic claim test**

Create `tests/ui/optimistic.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimButton } from '@/components/shift/claim-button'

afterEach(() => { vi.restoreAllMocks() })

describe('ClaimButton', () => {
  it('shows the claimed state immediately, before the server responds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))) // never resolves
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))
    expect(screen.getByRole('button', { name: /release/i })).toBeInTheDocument()
  })

  it('rolls back and shows the server\'s own message on rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'ROLE_FULL', message: 'This shift already has 3 of 3 nurses.' } }),
      { status: 409 },
    )))
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /claim/i })).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('This shift already has 3 of 3 nurses.')
    })
  })

  it('surfaces the overlap message verbatim rather than a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'OVERLAP', message: 'Overlaps a shift you already hold, 08:00–16:00 12 Aug.' } }),
      { status: 409 },
    )))
    render(<ClaimButton shiftId={1} claimed={false} userId={7} />)

    await userEvent.click(screen.getByRole('button', { name: /claim/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Overlaps a shift you already hold')
    })
  })
})
```

Install: `npm i -D @testing-library/user-event`

- [ ] **Step 5: Implement `claim-button.tsx`**

Create `components/shift/claim-button.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { newMutationId } from '@/hooks/use-realtime'

/**
 * Optimistic claim/release (§8.3). The state flips before the request lands and
 * rolls back on rejection, showing the SERVER's message — the same string the
 * validator produced. Surfacing it verbatim is what demonstrates the rule is
 * enforced server-side rather than guessed at in the client.
 */
export function ClaimButton({ shiftId, claimed, userId }: {
  shiftId: number
  claimed: boolean
  userId: number
}) {
  const [optimistic, setOptimistic] = useState(claimed)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function toggle() {
    const next = !optimistic
    const previous = optimistic

    setOptimistic(next)   // flip first
    setError(null)

    const mutationId = newMutationId()
    const res = next
      ? await fetch(`/api/shifts/${shiftId}/claims`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mutationId }),
        })
      : await fetch(`/api/shifts/${shiftId}/claims/${userId}?mutationId=${mutationId}`, {
          method: 'DELETE',
        })

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setOptimistic(previous)   // roll back
      setError(body?.error?.message ?? 'Something went wrong. Please try again.')
    }
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={() => startTransition(toggle)}
        disabled={pending}
        variant={optimistic ? 'outline' : 'default'}
      >
        {optimistic ? 'Release shift' : 'Claim shift'}
      </Button>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/ui`
Expected: PASS.

- [ ] **Step 7: Build the remaining screens**

Each follows the mockups from Task 16 and reuses the components above.

**`app/(app)/shifts/[id]/page.tsx`** — time, requirements as filled/total per
profession, claimant list, `<ClaimButton>` for staff. For managers: an assign
control (staff picker → `POST …/claims` with `userId`), plus Edit and Delete.

**`components/shift/edit-dialog.tsx`** — on submit, first `PATCH ?dryRun=1`. If
`dropped` is non-empty, show the drop preview naming each person and their reason,
requiring explicit confirmation. Confirming re-submits without `dryRun`, carrying
the `expectedVersion` from the preview. On `VERSION_CONFLICT`, re-run the preview
and tell the user it changed rather than silently retrying.

**`app/(app)/shifts/new/page.tsx`** — date, times, per-profession counts, and an
optional recurrence block (weekday checkboxes + until-date) posting to
`POST /api/shifts`.

**`app/(app)/my-shifts/page.tsx`** — the signed-in staff member's claims, upcoming
first, with release buttons and a notice area listing any `shift.claims_dropped`
events affecting them.

**`app/(app)/import/page.tsx`** — a file input with a STAFF/SHIFT selector posting
to `POST /api/imports`, plus the paginated run history linking to each report.

**`app/(app)/import/[runId]/page.tsx`** — the Import Report. Four stat tiles
(accepted / repaired / merged / rejected), outcome filter tabs, and a paginated
table where each row shows the **raw source line** in monospace, its outcome chip,
and every issue as `message` with `before → after` when present. This is the
brief's explicit deliverable: for every rejected or merged row, the row, what was
wrong, and what was done.

Wire `useRealtimeWeek` into the dashboard and shift detail pages, with `onResync`
calling `router.refresh()`.

- [ ] **Step 8: Verify the full flow manually**

```bash
docker compose up
```

Then, in two browser windows:
1. Sign in as the manager in one, a nurse in the other.
2. Nurse claims a shift → the manager's dashboard card updates without refresh.
3. Nurse claims an overlapping shift → rejected with the overlap message naming
   the conflicting shift.
4. Manager edits that shift's time to collide with another of the nurse's →
   preview names the nurse and the reason; confirming drops them and the nurse's
   `/my-shifts` shows the notice.
5. Manager uploads `staff.csv` at `/import` → report shows 34/3/4 with the Janitor
   row explaining exactly why it was rejected.

- [ ] **Step 9: Commit**

```bash
git add hooks components/shift app/\(app\) tests/ui
git commit -m "feat: add optimistic claiming, realtime week sync and remaining screens

Claim state flips before the request lands and rolls back showing the server's
own rejection message. Realtime reconciliation is a pure reducer, so echo
suppression and replay are tested without a socket.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Documentation and deployment

**Files:**
- Modify: `README.md`
- Create: `DECISIONS.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything.
- Produces: a deployed URL, a reviewable README, and the decisions document the brief requires.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS across import, rules, concurrency, contracts, rbac, api, seed and ui.
Record the actual counts — the README should not claim more than you ran.

- [ ] **Step 2: Write the README**

Rewrite `README.md` covering, in this order: what it is; the stack and why;
**one-command local setup** (`docker compose up`, noting it migrates and seeds
automatically); the test command; **seeded credentials** — the manager plus one
doctor, one nurse and one receptionist, choosing staff who already hold
overlapping claims so a reviewer can trigger both rejection rules immediately;
the live URL with a cold-start note; and a short "what to look at" list pointing
at the import report, the concurrency test, and the edit drop-preview.

- [ ] **Step 3: Write DECISIONS.md**

Cover each decision with its reasoning:

- **Editing a shift with claims** — re-validate and drop only genuine conflicts,
  with preview + version-guarded confirm (§4.3); why not block-the-edit.
- **Date formats** — `dd/mm/yyyy` and `mm-dd-yyyy` established from corpus
  evidence and cross-checked against shift_id ordering (§2.2), not guessed.
- **The same-slot trap** — why the shift merge key includes requirements, and
  that keying on the time slot alone would have destroyed ~40 real shifts.
- **Two deliberate non-actions** — never re-casing personal names; never
  word-parsing free-text requirements.
- **Rejecting blank emails** — email is the login identity.
- **Concurrency** — advisory locks in a fixed global order, why that ordering
  prevents deadlock, and the unique-constraint backstop.
- **SSE → Supabase Realtime** — the transport substitution and which guarantees
  were preserved (§7.1).
- **Compressed week payload** — the readability trade-off and why it is confined
  to one endpoint.
- **Seeded claims** — why the seed goes through the real validator.
- **One thing to do differently with more time:** persist drop notices as a
  first-class `Notification` model rather than deriving them from the event
  outbox — the outbox is pruned, so a staff member who does not log in for a
  while can currently miss the fact that they were dropped from a shift.

- [ ] **Step 4: Add CI**

Create `.github/workflows/ci.yml` running `npm ci`, `npx prisma generate`,
`npm run build` and `npm test` on push. Testcontainers needs Docker, which
`ubuntu-latest` provides.

- [ ] **Step 5: Deploy**

1. Create the Supabase project; copy `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`
   and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
2. `npx prisma migrate deploy` against it — this installs the broadcast trigger,
   since the `realtime` schema exists there.
3. `npx tsx prisma/seed.ts` against it.
4. Deploy to Vercel with those env vars plus `AUTH_SECRET`, `CLINIC_TZ` and
   `SEED_PASSWORD`.
5. Verify on the deployed URL: sign in, claim a shift in two browsers, confirm the
   realtime update, and open the import report.

- [ ] **Step 6: Verify the deployment before claiming it works**

Confirm each: the dashboard shows all three coverage states; a duplicate claim is
rejected with a clear message; the import report shows 34/3/4 and 109/2/6; the
dashboard is usable at 390px.

- [ ] **Step 7: Commit**

```bash
git add README.md DECISIONS.md .github
git commit -m "docs: add README, DECISIONS and CI

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 Stack | 1 |
| §2 Source data analysis | 5, 6, 7 (encoded as rules and golden assertions) |
| §3 Data model | 2 |
| §4.1 Validator | 10 |
| §4.2 Concurrency | 10 |
| §4.3 Edit with claims | 11 |
| §4.4 Delete with claims | 11 |
| §4.5 Unclaim / past shifts | 10 (`SHIFT_IN_PAST` in validator and `unassignClaim`) |
| §5 Import engine | 4, 5, 6, 7, 8 |
| §6.1 Contracts | 12 |
| §6.2 Compressed JSON | 13 |
| §6.3 RBAC | 9 |
| §6.4 Pagination | 12 |
| §6.5 Endpoints | 12, 13, 14 |
| §7.1 Realtime fan-out | 14, 19 |
| §7.2 Seeding | 15 |
| §8.1 Visual language | 16 |
| §8.2 Screens | 17, 18, 19 |
| §8.3 Optimistic UI | 19 |
| §8.4 Skeletons | 17 |
| §9 Recurring shifts | 12 (`occurrenceDates` + series), 19 (form) |
| §10 Testing | throughout; suite complete at 20 |
| §11 Deliverables | 20 |

No spec section is unimplemented.

**Type consistency check:** `validateAssignment(shift, user, ctx, now)` keeps the
same four-parameter signature in Tasks 10 and 11. `ClaimContext` uses
`claimsByProfession` and `userOtherShifts` throughout. `EditPreview` is
`{ version, kept, dropped }` in `edit.ts`, the Zod schema and the dialog.
`ImportResult<T>` is `{ rows, accepted, stats }` in Tasks 7, 8 and 15.
`CompressedWeek` field names `w/p/s/h` match between encoder, decoder and route.
`STATUS_STYLES` entries carry `label/glyph/dot/chip` in both Task 16 and Task 18.

**Known ordering note:** `tests/rbac/routes.test.ts` (Task 9) is written before any
route exists and does not pass until Task 12. This is called out in Task 9 Step 7
so an implementer does not treat it as a failure.

