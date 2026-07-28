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

<!-- PLAN-CONTINUES -->
