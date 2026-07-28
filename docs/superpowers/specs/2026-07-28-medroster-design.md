# MedRoster — Design Spec

**Date:** 2026-07-28
**Status:** Approved
**Source brief:** `PROJECT_BRIEF.md` (Fullstack Take-Home: Clinic Shift Scheduler, 4 days)

A clinic shift scheduler. Managers create shifts and assign staff; staff claim shifts
subject to business rules the server enforces. The clinic's existing spreadsheet exports
are imported through a cleaning pipeline whose every decision is auditable.

---

## 1. Stack

| Concern | Choice |
|---|---|
| App | Next.js 15, App Router, TypeScript strict |
| DB | Postgres (Supabase), Prisma |
| Auth | Auth.js v5, credentials provider, bcrypt |
| Realtime | Supabase Realtime Broadcast |
| Styling | Tailwind + shadcn/ui, custom teal token set |
| Validation / contracts | Zod (single source of truth, shared client + server) |
| Tests | Vitest + Testcontainers (Postgres) |
| Deploy | Vercel + Supabase |
| Local | `docker compose up` (app + Postgres + migrate + seed) |

Vercel + Supabase has no meaningful cold start on the paths that matter; noted in the
README regardless.

---

## 2. Source data analysis

Both CSVs were profiled before design. Findings below are load-bearing — several
design decisions exist specifically because of them.

### 2.1 `staff.csv` — 41 data rows

- **Real data:** `staff_id` 100–133 (34 people).
- **Planted garbage:** `staff_id` 995–999 (5 rows), a contiguous sentinel block.
- **Role spellings (15 distinct):** `NURSE`, `RN`, `Nurse`, `nurse`, `Registered Nurse`,
  ` Nurse `, `Doctor`, `DOCTOR `, `MD`, `Physician`, `receptionist`, `Receptionist`,
  `Reception`, `recep.`, `Janitor`.
- **Exact duplicate rows:** id 103 (L20/L22), id 110 (L25/L26).
- **Same person, two ids:** Zainab Volkov as 999 and 105 — identical name and email.
- **Email collision across different people:** `hiro.iyer@clinicmail.test` on both
  107 Hiro Iyer and 998 J. Placeholder.
- **Malformed emails:** `(at)` instead of `@` on 122 Priya Weber, 115 Fatima Petrova.
- **Whitespace:** leading spaces on name (133 `  Karan ALI`), padded role values.
- **Missing fields:** 995 blank email, 996 blank name.

### 2.2 `shifts.csv` — 117 data rows

- **Real data:** `shift_id` 5000–5108, contiguous (109 unique ids, 110 rows incl. one
  duplicate).
- **Planted garbage:** `shift_id` 5109–5115 (7 rows), again a contiguous sentinel block.
- **Date formats:** 85× ISO `yyyy-mm-dd`, 24× slash, 8× dash.
- **Date ambiguity is resolvable from evidence, not guesswork:**
  - Slash form: first field reaches `30` ⇒ first field is the **day** ⇒ `dd/mm/yyyy`.
  - Dash form: second field reaches `27` ⇒ first field is the **month** ⇒ `mm-dd-yyyy`.
  - Cross-validated: shift ids run monotonically with date. Under this decoding there
    are **zero** ordering violations across all real rows (the only two violations
    involve ids 5109/5110, both in the garbage block).
- **Invalid rows:** `5110` date `2026-02-30` (non-existent); `5114` empty start time;
  `5113` requirements as free text `two nurses and a doctor`.
- **Impossible durations:** `5109` 15:00→09:00 (18h), `5112` 12:00→12:00 (24h),
  `5115` 08:00→10:00+1 (26h).
- **Partial requirement keys:** 6 rows omit one or two role keys.
- **Exact duplicate row:** id 5020 (L15/L33).
- **The same-slot trap:** 24 groups share date+start+end but carry **different**
  requirements (e.g. 2026-08-04 08:00–16:00 appears as ids 5003, 5004 and 5005 with
  different headcounts). Only **one** group — 5053/5054 — is a true duplicate, matching
  on date, time *and* requirements. A merge rule keyed on the time slot alone would
  silently destroy ~40 legitimate shifts.
- **Range:** 2026-08-03 … 2026-08-30, 28 days, 3–5 shifts/day.

### 2.3 Supply vs demand

109 accepted shifts require **385 staffed slots** (nurses 225, doctors 114,
receptionists 46) against **34 staff** (16 nurses, 8 doctors, 10 receptionists) —
roughly 14 shifts per nurse over 28 days. The roster is deliberately unstaffable. This
is realistic and is the reason a coverage dashboard exists, but it means an
import-only seed produces a wall of identical empty shifts. See §7.2.

> These figures are per *distinct entity after reconciliation*, not per CSV row.
> An earlier draft of this spec reported 388/226/115/47 and 17/8/11 by counting
> raw rows: the staff figures double-counted the two byte-identical duplicate
> rows (103, a receptionist; 110, a nurse), and the shift figures summed over ids
> 5000–5108, which wrongly includes 5054 (merged into 5053) and wrongly excludes
> 5111 (accepted with a repair). The corrected staff counts sum to 34, matching
> the accepted total — the arithmetic check the original numbers failed.

---

## 3. Data model

```
User             id, email (unique), name, passwordHash,
                 role (MANAGER | STAFF),
                 profession (DOCTOR | NURSE | RECEPTIONIST)?,   -- null for managers
                 externalId?                                     -- source csv staff_id

Shift            id, startsAt (timestamptz), endsAt (timestamptz),
                 seriesId?, detachedFromSeries (bool), version (int),
                 createdAt, updatedAt

ShiftRequirement shiftId, profession, requiredCount
                 UNIQUE (shiftId, profession)

Claim            id, shiftId, userId, assignedById?, createdAt
                 UNIQUE (shiftId, userId)

ShiftSeries      id, weekdays (int[]), startTime, endTime, untilDate, requirements

ImportRun        id, source (SEED | UPLOAD), fileKind (STAFF | SHIFT),
                 filename, actorId?, stats (jsonb), createdAt

ImportRowResult  id, importRunId, rowNumber, rawRow (text),
                 outcome (ACCEPTED | REPAIRED | MERGED | REJECTED),
                 issues (jsonb), entityId?

EventOutbox      id (bigserial), topic, type, payload (jsonb),
                 mutationId?, createdAt
```

**Requirements are normalized, not three integer columns.** The dashboard's "which roles
are still missing" becomes a join and aggregate rather than three hardcoded comparisons
duplicated across claim validation, edit re-validation, and the coverage query. Adding a
profession becomes a data change.

**Times are stored as UTC instants**, derived from clinic-local date + time under one
fixed clinic timezone (`CLINIC_TZ`, documented, default `Europe/London`). Overlap
detection is then plain timestamp comparison and overnight shifts (`22:00→06:00`) need
no special casing anywhere downstream of the importer.

Indexes: `Shift(startsAt, endsAt)`, `Claim(userId)`, `Claim(shiftId)`,
`ImportRowResult(importRunId, rowNumber)`, `EventOutbox(topic, id)`.

---

## 4. Business rules engine

### 4.1 One validator, four callers

```ts
validateAssignment(tx, shiftId, userId): Ok | { code: RuleCode; message: string }
```

Rules, in order:

1. **`SHIFT_IN_PAST`** — the shift has already started (see §4.5).
2. **`PROFESSION_NOT_REQUIRED`** — the shift has no requirement for this user's
   profession (`requiredCount = 0` or absent).
3. **`ROLE_FULL`** — existing claims by users of this profession ≥ `requiredCount`.
   Message names the numbers: *"This shift already has 3 of 3 nurses."*
4. **`OVERLAP`** — the user holds a claim on another shift whose `[startsAt, endsAt)`
   intersects this one. Message names the conflict: *"Overlaps your 08:00–16:00 shift
   on Aug 12."*

Callers: staff self-claim, manager assign, post-edit re-validation, and the claim
seeder. **No other code path writes a `Claim`.** This is what makes the brief's
requirement — that the rules hold for manager assignment and after time edits — true by
construction rather than by remembering.

### 4.2 Concurrency

Every mutation runs in one transaction that first acquires `pg_advisory_xact_lock`s in
a **fixed global order: shift ids before user ids, each ascending.** Fixed ordering is
what makes it deadlock-free when a shift edit locks one shift plus many users while a
staff member is concurrently claiming.

- `UNIQUE (shiftId, userId)` is the backstop against double-claim.
- Capacity cannot be oversold: concurrent claimants on a shift serialize on its lock.
- Serialization failures get a bounded retry (3 attempts, jittered).

### 4.3 Editing a shift that has claims

Policy: **re-validate and drop only what genuinely breaks.**

1. Manager submits an edit. Server computes, under lock, which existing claims would
   fail `validateAssignment` against the proposed state.
2. Response is a **preview**: the surviving claims and the exact list of people who
   would be dropped, with the reason per person. When a lowered requirement forces a
   drop, the most recently created claims are dropped first (seniority of commitment).
3. Manager confirms. The confirm carries the shift `version` it previewed against; the
   whole computation re-runs under lock and **aborts if the version has moved**, so a
   claim landing between preview and confirm invalidates the preview rather than
   slipping through unvalidated.
4. Drops are recorded and surfaced to affected staff in their `/my-shifts` view, and
   broadcast as `shift.claims_dropped`.

Preview and confirm run the same computation; the preview is the confirm in dry-run
mode.

### 4.4 Deleting a shift that has claims

Same shape as an edit: `DELETE ?dryRun=1` returns who currently holds the shift, and the
confirm carries the previewed `version`. Claims cascade with the shift and every
affected staff member gets a drop notice. A shift is never soft-deleted — the import
report and event outbox already provide the audit trail.

### 4.5 Unclaim and past shifts

- Staff may unclaim any **future** shift they hold, freely and without approval; the
  clinic's recourse for late drops is social, not technical.
- Claims on a shift whose `startsAt` is in the past are immutable — neither staff nor
  manager may claim or unclaim it (`SHIFT_IN_PAST`). Managers can still edit or delete
  a past shift to correct records.
- `validateAssignment` rejects claims on shifts that have already started, for staff and
  managers alike. The seeded roster is entirely in the future, so this rule is inert on
  fresh data and exists for correctness over time.

---

## 5. Import engine

`lib/import/` is framework-free and DB-free. Only `applyImport(tx, result)` touches the
database. Three callers — the seed, the manager upload endpoint, and the tests — run the
identical engine.

### 5.1 Pipeline

```
parse ──► normalize ──► coerce ──► validate ──► reconcile
```

Each stage may attach an `Issue { code, severity, field, message, before?, after? }`.
Outcome is derived from the issues, not set by hand:

- any `FATAL` → **`REJECTED`**
- else merged into an existing record → **`MERGED`**
- else any `REPAIR` → **`REPAIRED`**
- else → **`ACCEPTED`**

The pipeline is assembled from a **rule registry** via factories (`createFieldRule`,
`createRowValidator`), so every rule below is a registry entry, and the rules table, the
test suite, and the Import Report legend are generated from that one registry rather
than maintained in three places.

### 5.2 Rules — staff

| Condition | Action | Outcome |
|---|---|---|
| `RN`, `Registered Nurse`, `NURSE`, `nurse`, `Nurse` | → `NURSE` | REPAIR |
| `MD`, `Physician`, `Doctor`, `DOCTOR` | → `DOCTOR` | REPAIR |
| `recep.`, `Reception`, `Receptionist`, `receptionist` | → `RECEPTIONIST` | REPAIR |
| Any other role value (`Janitor`) | reject — cannot invent a schedulable profession | FATAL |
| `(at)` in email | → `@` | REPAIR |
| Leading/trailing/repeated whitespace | trim + collapse | REPAIR |
| Blank name | reject | FATAL |
| Blank email | reject — email is the login identity | FATAL |
| Email not matching address shape after repair | reject | FATAL |
| Email already used by a **different** name (998 vs 107) | reject the later row | FATAL |
| Byte-identical duplicate row (103, 110) | drop the later | MERGED |
| Same `staff_id`, differing fields | keep first, log the diff | MERGED |
| Same name + email, different id (999/105) | merge into **lowest** id | MERGED |

Role matching is case-insensitive with whitespace collapsed and a trailing period
stripped.

### 5.3 Rules — shifts

| Condition | Action | Outcome |
|---|---|---|
| `yyyy-mm-dd` | accept | — |
| `dd/mm/yyyy` | → ISO | REPAIR |
| `mm-dd-yyyy` | → ISO | REPAIR |
| Slash/dash date where both fields > 12 | reject — unresolvable | FATAL |
| Date that does not exist (`2026-02-30`) | reject | FATAL |
| Missing start or end time | reject | FATAL |
| Time not `HH:MM` (optionally `+1`) | reject | FATAL |
| `HH:MM+1` | end = next day | REPAIR |
| `end ≤ start` | roll end forward one day | REPAIR |
| Resulting duration `0` or `> 12h` | reject | FATAL |
| Requirement key absent | default `0` | REPAIR |
| Unknown requirement key | reject | FATAL |
| Total required headcount `0` | reject — not a shift | FATAL |
| Requirements not `key=int;…` (`two nurses and a doctor`) | reject — not word-parsed | FATAL |
| Byte-identical duplicate row (5020) | drop the later | MERGED |
| Same date + time + **requirements**, different id (5053/5054) | merge into lowest id | MERGED |

The single duration rule (roll forward, then cap at 12h) is what catches 5109 (18h),
5112 (24h) and 5115 (26h) without three special cases, while legitimate `22:00→06:00`
overnights (8h) pass cleanly.

### 5.4 Two deliberate non-actions

**Personal names are never re-cased.** `ALI`, `McDonald`, `van der Berg` and `O'Neill`
are not typos; only whitespace is touched. Role values *are* case-normalized because
they map onto a closed enum.

**Same-slot shifts with differing requirements are never merged.** Per §2.2 this would
destroy ~40 legitimate rows. The merge key includes requirements.

### 5.5 Expected result

The Import Report must reproduce exactly:

| File | Accepted (incl. repaired) | Merged | Rejected | Total |
|---|---|---|---|---|
| `staff.csv` | 34 | 3 | 4 | 41 |
| `shifts.csv` | 109 | 2 | 6 | 117 |

Rejections: staff — 995 blank email, 996 blank name, 997 unknown profession, 998 email
collision. Shifts — 5109, 5110, 5112, 5113, 5114, 5115. (5111 is accepted with a repair;
its only defect is omitted requirement keys.) A golden-file test asserts these counts.

---

## 6. API and access control

### 6.1 Contracts

One Zod schema per endpoint in `lib/contracts/`, exporting request and response shapes.
Route handlers parse with it; the client infers its types from it; tests assert against
it. **No hand-written TypeScript interface duplicates a schema.**

### 6.2 Compressed JSON

**Payload shape.** The week endpoint carries 5 shifts/day × 7 days, each with
requirements and claims; naively every claim repeats a full staff object. Instead the
envelope carries a `refs` dictionary once and entities reference it by index:

```json
{
  "refs": { "staff": [[12,"Ivy Bell",1],[3,"Omar Patel",0]],
            "prof":  ["doctor","nurse","receptionist"] },
  "shifts": [[501,"2026-08-12T06:30Z","2026-08-12T14:30Z",[[1,3],[0,1]],[0,1]]]
}
```

Profession strings and staff names appear once per response rather than once per claim
— roughly 4–5× smaller on a full week. **Cost:** the payload is not readable raw in
devtools. Mitigation: encoder and decoder live together in `lib/contracts/`, are
round-trip unit-tested, and this encoding is applied **only** to the week endpoint.
Every other endpoint stays plain readable JSON.

**Transport.** Brotli on JSON responses; `ETag` + `304` on the week endpoint so
flipping back to an already-seen week costs nothing.

### 6.3 RBAC

A single capability catalog — not role checks scattered through handlers:

```
shift:read   shift:create   shift:update   shift:delete
claim:create:self   claim:create:any   claim:delete:self   claim:delete:any
import:run   import:read   staff:read
```

`ROLE_PERMISSIONS: Record<Role, Set<Permission>>` maps roles to capabilities. Every
route handler and server action is wrapped in `withAuth(permission, handler)` — a
handler cannot be registered without declaring one, so a missing guard is a type error
rather than a silent hole. Resource-level ownership (`:self` vs `:any`) is checked
inside the same wrapper against the target resource.

**The client imports the same catalog** to disable or hide controls, so the button a
staff member cannot press and the endpoint that would reject them are driven by one
table. A test enumerates every route module and asserts each declares a permission.

`role` and `profession` ride in the Auth.js JWT so permission resolution needs no DB
round-trip per request.

### 6.4 Pagination

Keyset (cursor), not offset: `?cursor=<opaque>&limit=` → `{ items, nextCursor }`.
Offset pagination would skip or repeat rows as shifts and claims mutate under a
scrolling list, which here they do, live. Applied to: import report rows, staff
directory, shift lists, `/my-shifts`.

**The coverage dashboard is not paginated** — a week is already a bounded window and
paginating it would defeat the at-a-glance requirement.

### 6.5 Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/api/weeks/[isoWeek]` | `shift:read` |
| GET | `/api/shifts` (cursor) | `shift:read` |
| POST | `/api/shifts` | `shift:create` |
| GET | `/api/shifts/[id]` | `shift:read` |
| PATCH | `/api/shifts/[id]` (`?dryRun=1` → preview) | `shift:update` |
| DELETE | `/api/shifts/[id]` (`?dryRun=1` → preview) | `shift:delete` |
| POST | `/api/shifts/[id]/claims` | `claim:create:self` \| `claim:create:any` |
| DELETE | `/api/shifts/[id]/claims/[userId]` | `claim:delete:self` \| `claim:delete:any` |
| GET | `/api/staff` (cursor) | `staff:read` |
| POST | `/api/imports` (multipart) | `import:run` |
| GET | `/api/imports` (cursor) | `import:read` |
| GET | `/api/imports/[runId]` (cursor rows) | `import:read` |
| GET | `/api/events/since?id=` | `shift:read` |

---

## 7. Realtime

### 7.1 Fan-out

```
mutation tx ──► INSERT INTO event_outbox (id, topic, type, payload, mutation_id)
             └─ AFTER INSERT trigger ──► realtime.send(payload, type, topic)
                                          └─► every subscriber on that channel
```

Emitting from a trigger on the outbox insert — rather than from application code after
the transaction — preserves the commit guarantee: a rolled-back claim never emits, a
committed one always does, and the two cannot drift.

**Broadcast, not Postgres Changes**, so subscribers receive domain events
(`shift.claimed`, `shift.unclaimed`, `shift.created`, `shift.edited`,
`shift.deleted`, `shift.claims_dropped`) rather than raw row diffs, and we control the
topic. Topics are `week:<iso-week>`, so a claim on Aug 12 does not wake subscribers
viewing Aug 20.

**Replay.** `EventOutbox.id` is monotonic; the client tracks its last seen id and, on
reconnect, calls `GET /api/events/since?id=` and applies the gap. Realtime broadcast
alone is at-most-once with no replay; the outbox is what closes that hole.

**Echo suppression.** Each mutation carries a client-generated `mutationId` that
round-trips through the event payload. The originating client drops its own echo
(already applied optimistically); every other subscriber applies it.

**Divergence.** If the client cannot reconcile a gap, it emits `resync` and refetches
the week rather than silently drifting.

> **Note on SSE.** The brief's fan-out requirement was specified as SSE. Supabase
> Realtime is WebSocket, so it replaces SSE as the transport. All the guarantees —
> every subscriber on a topic receiving every event, no loss across reconnect, no
> self-echo flicker — are preserved; only the wire protocol differs. Wrapping Realtime
> in an SSE re-emitter on Vercel would add a hop, hold a function slot per viewer, and
> still be cut by the platform duration cap.

### 7.2 Seeding

The seed runs the import engine, then a **deterministic claim seeder** (fixed RNG seed)
that assigns staff **through `validateAssignment`** — no direct `Claim` writes. Tuned so
the roster shows a genuine mix of fully staffed, partially staffed with specific roles
missing, and empty shifts, and so that some staff already hold overlapping-adjacent
claims. This makes all three dashboard states and both rejection rules reachable within
a minute of logging in, and doubles as an integration test of the validator.

Managers can additionally upload a CSV through the UI, which runs the identical engine
and produces its own `ImportRun` and report.

---

## 8. UI

### 8.1 Visual language

Clinical teal → cyan, applied with the reference's treatment (soft gradient hero,
floating cards, generous whitespace, large display type).

```
--brand-primary   #0D9488   teal
--brand-mid       #5EEAD4   gradient mid
--surface-tint    #ECFDF8
--ink             #0F172A
status: full = emerald · partial = amber · empty = rose
```

Status colours sit outside the brand family deliberately, so "partially staffed" amber
never reads as brand chrome. Mockups are produced in Pencil before UI code is written.

### 8.2 Screens

| Route | Who | Contents |
|---|---|---|
| `/` | public | Landing — gradient hero, floating dashboard card, feature blocks, FAQ |
| `/login` | public | Credentials sign-in |
| `/dashboard` | manager | Week-at-a-glance grid; per-shift status and **named** missing roles; jump-to-week (prev/next, date picker, today) |
| `/shifts/new` | manager | Create, incl. recurring series |
| `/shifts/[id]` | both | Detail; claim/unclaim; manager assign; edit with drop preview |
| `/my-shifts` | staff | Own claims, upcoming first, drop notices |
| `/import` | manager | Upload CSV; run history |
| `/import/[runId]` | manager | Import Report — counts, and per row the raw row, what was wrong, what was done |

The dashboard is checked for responsiveness: the 7-column grid collapses to a
day-stacked list under `md`, keeping status and missing roles visible at every width.

### 8.3 Optimistic UI

Claim/unclaim flips instantly and rolls back on rejection, surfacing **the server's
actual message** — the same string the validator produced, never a client-side guess.
The rollback path is what proves server enforcement rather than hiding it.

### 8.4 Skeletons

Suspense boundaries at route and panel level. Skeletons are built from the **same layout
primitives** as the real components so dimensions match and nothing shifts on
hydration. Streaming SSR paints the week grid chrome before its data resolves.

---

## 9. Recurring shifts

`ShiftSeries` holds the rule (weekdays, times, requirements, until-date). Occurrences
are **materialized** as real `Shift` rows carrying `seriesId`. Editing a single
occurrence sets `detachedFromSeries`; series-level edits skip detached rows. Deleting an
occurrence deletes that row only.

Materializing rather than computing occurrences on the fly means claims, the validator
and the coverage query know nothing about recurrence — it stays confined to the
creation path.

---

## 10. Testing

`npm test` — Vitest, one documented command.

1. **Import engine (pure, no DB).** Table-driven: every rule in §5.2/§5.3 is a case,
   generated from the same rule registry that drives the pipeline.
2. **Golden file.** The shipped CSVs produce exactly 34/3/4 and 109/2/6, with the named
   rejection set.
3. **Rules engine.** Each rejection reason; manager assignment obeys the same rules;
   post-edit re-validation drops exactly the right claims.
4. **Concurrency (real Postgres via Testcontainers).** N parallel claims on a 2-nurse
   shift yield exactly 2 winners and N−2 clear rejections. Preview/confirm with an
   interleaved claim aborts on version mismatch.
5. **RBAC.** Enumerate every route module; assert each declares a permission; assert
   staff cannot act on another user's claims.
6. **Contracts.** Round-trip the compressed week encoder/decoder.

---

## 11. Deliverables

- Live URL on Vercel, pre-seeded via the importer.
- `README.md` — stack, `docker compose up`, `npm test`, seeded credentials (manager +
  one doctor, nurse, receptionist chosen for pre-seeded conflicts), cold-start note.
- `DECISIONS.md` — the edit-with-claims policy (§4.3), the two deliberate non-actions
  (§5.4), the date-format evidence (§2.2), the SSE→Realtime substitution (§7.1), and
  one thing to do differently with more time.
- Meaningful, incremental commits.

---

## 12. Out of scope

Shift swaps between staff; notifications/email; multi-clinic tenancy; staff
availability preferences; payroll or hours reporting; password reset; audit log beyond
the import report and drop notices.
