# Supabase Auth Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the account lifecycle on top of the Supabase Auth foundation — a manager can invite someone by email, that person accepts and sets a password, everyone can reset or change their password or sign in passwordlessly, and a manager can offboard someone so their future shifts reopen.

**Architecture:** Every privileged mutation is an `app/api/**/route.ts` handler produced by `withAuth()` — never a Server Action — because `tests/rbac/routes.test.ts` structurally enforces that guard and cannot see Server Actions. Supabase's admin API is reached only from `.ts` route handlers, never from a page, because `tests/auth/admin-containment.test.ts` treats every `.tsx` file as client-reachable. Emailed links carry a `token_hash` to a server route that exchanges it for a cookie session (Task 7), because GoTrue's default links deliver tokens in the URL fragment where no server can read them. The roster gate from Plan 1 becomes the single decision point behind sign-in, magic link, OAuth and every emailed link alike.

**Measured before writing.** A real invite was sent through the live local stack and the emailed link followed. Two findings shaped this plan and are recorded in full at the top of Task 7: the default link returns tokens in the **URL fragment** (so the Server-Component design this plan originally used could never have worked), and `redirect_to` was **silently ignored** because `supabase/config.toml` allow-listed the wrong scheme. Task 7 exists to fix both, and is sequenced before every screen that depends on it.

**Tech Stack:** Next.js 15 App Router, TypeScript strict, Prisma 7 + Postgres, `@supabase/ssr` 0.12.x, `@supabase/supabase-js` 2.x, Zod, Vitest + Testcontainers, Playwright, Mailpit (local mail catcher).

**Source spec:** `docs/superpowers/specs/2026-07-30-supabase-auth-design.md` §5–9. Plan 1 (`2026-07-30-supabase-auth-foundation.md`) delivered §7 steps 1–4 and is merged.

## Global Constraints

- **Every privileged mutation is a `withAuth()`-wrapped route handler in `app/api/**/route.ts`.** Do not use Server Actions for member mutations: `tests/rbac/routes.test.ts` verifies the `WITH_AUTH_BRAND` on exported route handlers and has no visibility into Server Actions, so an action is an unguarded endpoint by construction.
- **`lib/supabase/admin.ts` must never be reachable from a `.tsx` file.** `isClientReachable` (`tests/auth/admin-containment.test.ts:81-84`) returns true for *any* `.tsx`, transitively. The members page renders; a route handler invites.
- Role and profession are written to Supabase **`app_metadata`**, never `user_metadata` — `user_metadata` is user-writable, so a role stored there is self-assignable. (Spec §2)
- Authorization always reads the `User` profile row. Token claims are a hint and are currently read by nothing; keep it that way.
- Use `supabase.auth.getUser()`, never `getSession()`.
- The roster gate must fail closed: no profile, `deactivatedAt` set, or (new in this plan) no `authUserId` on an email-keyed lookup ⇒ no session.
- Deactivation releases claims on shifts that have **not started**; claims on past shifts are history and stay. Every affected shift emits `EventOutbox` rows or open dashboards will show staffing that no longer exists. (Spec §5.5)
- Full suite must stay green. Run `npm test` in the **foreground**; it takes ~8-10 minutes.
- Do NOT run `prisma migrate reset` or `supabase db reset` — the dev database also holds Supabase's own `auth`, `storage` and `realtime` schemas.
- Local stack: `npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,storage-api,postgres-meta`. API `:54321`, Postgres `:54322`, Mailpit `:54324`.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/auth/roster-gate.ts` *(modify)* | Gains `checkRosterByEmail` — the email-keyed variant that also demands `authUserId` |
| `lib/auth/permissions.ts` *(modify)* | Adds `member:read`, `member:invite`, `member:manage` |
| `lib/contracts/members.ts` *(new)* | Zod schemas for the invite and deactivate payloads |
| `lib/members/status.ts` *(new)* | Pure derivation of account status from profile + Supabase user |
| `lib/members/invite.ts` *(new)* | Invite/resend/revoke against the admin API, and profile linking |
| `lib/members/deactivate.ts` *(new)* | The offboarding transaction: ban, mark, release future claims, emit events |
| `app/api/members/route.ts` *(new)* | `GET` list, `POST` invite |
| `app/api/members/[id]/route.ts` *(new)* | `DELETE` deactivate |
| `app/api/members/[id]/invite/route.ts` *(new)* | `POST` resend, `DELETE` revoke |
| `app/(app)/members/page.tsx` *(new)* | Manager-only members list (renders only) |
| `app/(app)/members/members-table.tsx` *(new)* | Client component: invite form, resend/revoke/deactivate buttons |
| `app/auth/callback/route.ts` *(new)* | OAuth/magic-link code exchange + roster gate |
| `app/auth/accept-invite/page.tsx` *(new)* | Set-password screen, branching on how the invitee arrived |
| `app/auth/reset-password/page.tsx` *(new)* | Set-new-password screen after a recovery link |
| `app/forgot-password/page.tsx` *(new)* | Public request-a-reset form |
| `app/(app)/account/page.tsx` *(new)* | Change password while signed in |

---

### Task 1: The email-keyed roster gate

Plan 1's `checkRoster` takes a profile already looked up by `authUserId`, so an un-invited CSV row is unreachable. Every flow in this plan looks up by **email**, where those rows *are* reachable — an imported staff member who was never invited must not be able to sign in. This task closes that before anything depends on it.

**Files:**
- Modify: `lib/auth/roster-gate.ts`
- Test: `tests/auth/roster-gate.test.ts`

**Interfaces:**
- Consumes: existing `checkRoster(profile: RosterProfile | null): GateResult`, `GateResult = { allowed: true } | { allowed: false; reason: string }`.
- Produces: `interface EmailRosterProfile { deactivatedAt: Date | null; authUserId: string | null }` and `checkRosterByEmail(profile: EmailRosterProfile | null): GateResult`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth/roster-gate.test.ts`:

```ts
import { checkRoster, checkRosterByEmail } from '@/lib/auth/roster-gate'

describe('checkRosterByEmail', () => {
  it('allows an active member who has an account', () => {
    expect(checkRosterByEmail({ deactivatedAt: null, authUserId: 'uid-1' }))
      .toEqual({ allowed: true })
  })

  it('refuses an address with no profile at all', () => {
    const result = checkRosterByEmail(null)
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/ask a manager for an invite/i)
  })

  // The reason this function exists. An imported staff row has a profile and a
  // real email but was never invited, so authUserId is null. Keyed by
  // authUserId those rows cannot be found at all; keyed by EMAIL they can, and
  // treating one as a member would let anyone who knows a colleague's address
  // sign in as them via magic link.
  it('refuses a profile that was never invited, even though it exists', () => {
    const result = checkRosterByEmail({ deactivatedAt: null, authUserId: null })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/ask a manager for an invite/i)
  })

  it('refuses a deactivated member who does have an account', () => {
    const result = checkRosterByEmail({ deactivatedAt: new Date('2026-01-01'), authUserId: 'uid-2' })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/no longer active/i)
  })

  it('prefers the deactivated reason when a member is both deactivated and unlinked', () => {
    const result = checkRosterByEmail({ deactivatedAt: new Date('2026-01-01'), authUserId: null })
    expect(result.allowed).toBe(false)
    expect(result.allowed === false && result.reason).toMatch(/no longer active/i)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/auth/roster-gate.test.ts`
Expected: FAIL — `checkRosterByEmail` is not exported.

- [ ] **Step 3: Implement it**

Add to `lib/auth/roster-gate.ts`, below the existing `checkRoster`:

```ts
export interface EmailRosterProfile extends RosterProfile {
  authUserId: string | null
}

/**
 * The roster gate for flows that identify someone by EMAIL rather than by
 * Supabase uid — magic link, OAuth callback, password recovery.
 *
 * Strictly stronger than `checkRoster`, and the difference is the point. A
 * profile looked up by `authUserId` necessarily has one; a profile looked up by
 * email may be an imported `staff.csv` row that was never invited
 * (`authUserId: null`). Those rows carry a real, guessable work address, so
 * admitting them would let anyone who knows a colleague's email request a
 * magic link and sign in as them.
 *
 * Order matters: a deactivated member gets the deactivated reason even if they
 * also have no `authUserId`, because "your access was removed" is the true and
 * more useful answer.
 */
export function checkRosterByEmail(profile: EmailRosterProfile | null): GateResult {
  const base = checkRoster(profile)
  if (!base.allowed) return base
  if (!profile!.authUserId) {
    return {
      allowed: false,
      reason: "This email isn't on the roster — ask a manager for an invite.",
    }
  }
  return { allowed: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/auth/roster-gate.test.ts`
Expected: PASS — 8 tests (3 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/roster-gate.ts tests/auth/roster-gate.test.ts
git commit -m "feat(auth): gate email-keyed sign-in on having been invited"
```

---

### Task 2: Member permissions and derived account status

Two small, pure pieces the API routes and the page both need. Landing them together because neither is worth its own review pass and the status derivation is meaningless without the permissions that expose it.

**Files:**
- Modify: `lib/auth/permissions.ts:3-9`
- Create: `lib/members/status.ts`
- Test: `tests/members/status.test.ts` (create)

**Interfaces:**
- Produces:
  - `Permission` union gains `'member:read' | 'member:invite' | 'member:manage'`.
  - `type MemberStatus = 'active' | 'invited' | 'deactivated' | 'no-account'`
  - `interface StatusInputs { authUserId: string | null; deactivatedAt: Date | null; authUser: { confirmedAt: Date | null } | null }`
  - `memberStatus(inputs: StatusInputs): MemberStatus`

- [ ] **Step 1: Write the failing tests**

Create `tests/members/status.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { memberStatus } from '@/lib/members/status'

const NEVER_INVITED = { authUserId: null, deactivatedAt: null, authUser: null }

describe('memberStatus', () => {
  it('is no-account for an imported profile that was never invited', () => {
    expect(memberStatus(NEVER_INVITED)).toBe('no-account')
  })

  it('is invited when the auth user exists but has not confirmed', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: null, authUser: { confirmedAt: null },
    })).toBe('invited')
  })

  it('is active once the invite has been accepted', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: null, authUser: { confirmedAt: new Date() },
    })).toBe('active')
  })

  it('is deactivated regardless of confirmation state', () => {
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: new Date(), authUser: { confirmedAt: new Date() },
    })).toBe('deactivated')
    expect(memberStatus({
      authUserId: 'uid-1', deactivatedAt: new Date(), authUser: { confirmedAt: null },
    })).toBe('deactivated')
  })

  // Drift between the two stores is possible — a Supabase user deleted from the
  // dashboard leaves a linked profile behind. Reporting that as `active` would
  // show a manager someone who cannot sign in, so it degrades to no-account.
  it('degrades to no-account when the linked auth user has vanished', () => {
    expect(memberStatus({
      authUserId: 'uid-gone', deactivatedAt: null, authUser: null,
    })).toBe('no-account')
  })

  it('still reports deactivated when the auth user has vanished', () => {
    expect(memberStatus({
      authUserId: 'uid-gone', deactivatedAt: new Date(), authUser: null,
    })).toBe('deactivated')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/members/status.test.ts`
Expected: FAIL — cannot resolve `@/lib/members/status`.

- [ ] **Step 3: Add the permissions**

In `lib/auth/permissions.ts`, extend `ALL_PERMISSIONS` (lines 3-9) with a third group:

```ts
export const ALL_PERMISSIONS = [
  'shift:read', 'shift:create', 'shift:update', 'shift:delete',
  'claim:create:self', 'claim:create:any',
  'claim:delete:self', 'claim:delete:any',
  'import:run', 'import:read',
  'staff:read',
  // Manager-only. `staff:read` above is deliberately NOT one of these: it is a
  // STAFF-level directory of names and professions for the assignment UI, and
  // it must not grow into "read every colleague's email and account state".
  'member:read', 'member:invite', 'member:manage',
] as const
```

`STAFF_PERMISSIONS` is unchanged, so `ROLE_PERMISSIONS.MANAGER` (which spreads `ALL_PERMISSIONS`) picks up all three and STAFF gets none.

- [ ] **Step 4: Implement the status derivation**

Create `lib/members/status.ts`:

```ts
export type MemberStatus = 'active' | 'invited' | 'deactivated' | 'no-account'

export interface StatusInputs {
  /** Supabase auth.users.id, or null for a profile that was never invited. */
  authUserId: string | null
  deactivatedAt: Date | null
  /** The matching Supabase user, or null if none was found for this uid. */
  authUser: { confirmedAt: Date | null } | null
}

/**
 * Account status is DERIVED, never stored (spec §3.1).
 *
 * A stored status column would be a second source of truth that drifts from
 * Supabase the moment anyone touches the dashboard — and the drift is invisible
 * until someone cannot sign in. Deriving costs one `admin.listUsers()` call
 * joined in memory and cannot go stale.
 */
export function memberStatus({ authUserId, deactivatedAt, authUser }: StatusInputs): MemberStatus {
  if (deactivatedAt) return 'deactivated'
  if (!authUserId || !authUser) return 'no-account'
  return authUser.confirmedAt ? 'active' : 'invited'
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/members/status.test.ts && npx tsc --noEmit`
Expected: PASS — 6 tests, type-clean.

- [ ] **Step 6: Commit**

```bash
git add lib/auth/permissions.ts lib/members/status.ts tests/members/status.test.ts
git commit -m "feat(members): add member permissions and derived account status"
```

---

### Task 3: The invite service

The centrepiece. Isolated from HTTP so its branches are testable against a fake admin API, exactly as `lib/seed/auth-accounts.ts` is.

**Files:**
- Create: `lib/members/invite.ts`
- Create: `lib/contracts/members.ts`
- Test: `tests/members/invite.test.ts` (create)

**Interfaces:**
- Consumes: `prisma` from `@/lib/db/client`.
- Produces:
  - `interface InviteAdminPort` — `inviteUserByEmail`, `updateUserById`, `listUsers`, `deleteUser`.
  - `inviteMember(db, admin, input): Promise<{ userId: number } | AppError>` where `input` is `{ email: string; name: string; role: Role; profession: Profession | null; redirectTo: string }`.
  - `resendInvite(db, admin, userId, redirectTo): Promise<{ ok: true } | AppError>`
  - `revokeInvite(db, admin, userId): Promise<{ ok: true } | AppError>`
  - `lib/contracts/members.ts`: `inviteMemberSchema`, `InviteMemberInput`.

- [ ] **Step 1: Write the contract**

Create `lib/contracts/members.ts`:

```ts
import { z } from 'zod'

/**
 * Role and profession are chosen by the inviting MANAGER and are never supplied
 * by the invitee — that is what keeps the RBAC model airtight under an
 * invite-only policy (spec §1). A STAFF member must carry a profession, since
 * every claim rule is keyed on it; a MANAGER must not.
 */
export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  name: z.string().trim().min(1, 'Enter the person’s name.'),
  role: z.enum(['MANAGER', 'STAFF']),
  profession: z.enum(['DOCTOR', 'NURSE', 'RECEPTIONIST']).nullable(),
}).refine(
  (v) => (v.role === 'STAFF' ? v.profession !== null : v.profession === null),
  { message: 'Staff need a profession; managers must not have one.', path: ['profession'] },
)

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>
```

- [ ] **Step 2: Write the failing tests**

Create `tests/members/invite.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { inviteMember, resendInvite, revokeInvite, type InviteAdminPort } from '@/lib/members/invite'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const REDIRECT = 'http://localhost:3000/auth/accept-invite'

type CreatedCall = { email: string; options?: { redirectTo?: string } }

function fakeAdmin(seed: { id: string; email: string }[] = []) {
  const users = [...seed]
  let next = seed.length + 1
  const calls = {
    invited: [] as CreatedCall[],
    updated: [] as { id: string; attrs: Record<string, unknown> }[],
    deleted: [] as string[],
  }

  const port: InviteAdminPort = {
    inviteUserByEmail: (email, options) => {
      calls.invited.push({ email, options })
      if (users.some((u) => u.email === email)) {
        return Promise.resolve({ data: { user: null }, error: { code: 'email_exists' } })
      }
      const user = { id: `uid-${next++}`, email }
      users.push(user)
      return Promise.resolve({ data: { user }, error: null })
    },
    updateUserById: (id, attrs) => {
      calls.updated.push({ id, attrs })
      return Promise.resolve({ data: { user: { id } }, error: null })
    },
    listUsers: () => Promise.resolve({ data: { users: users.map((u) => ({ ...u })) }, error: null }),
    deleteUser: (id) => {
      calls.deleted.push(id)
      const i = users.findIndex((u) => u.id === id)
      if (i >= 0) users.splice(i, 1)
      return Promise.resolve({ error: null })
    },
  }
  return { port, calls }
}

const NURSE = {
  email: 'new.nurse@clinicmail.test', name: 'Nadia Nurse',
  role: 'STAFF' as const, profession: 'NURSE' as const, redirectTo: REDIRECT,
}

describe('inviteMember', () => {
  it('creates the auth user, sends the invite, and links a new profile', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ userId: expect.any(Number) })
    expect(calls.invited).toHaveLength(1)
    expect(calls.invited[0]!.options?.redirectTo).toBe(REDIRECT)

    const profile = await db.user.findUniqueOrThrow({ where: { email: NURSE.email } })
    expect(profile.authUserId).toBe('uid-1')
    expect(profile.role).toBe('STAFF')
    expect(profile.profession).toBe('NURSE')
  })

  // The security property: role must land where the user cannot rewrite it.
  it('writes role and profession to app_metadata, never user_metadata', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()

    await inviteMember(db, port, NURSE)

    expect(calls.updated).toHaveLength(1)
    expect(calls.updated[0]!.attrs).toEqual({
      app_metadata: { role: 'STAFF', profession: 'NURSE' },
    })
    expect(calls.updated[0]!.attrs).not.toHaveProperty('user_metadata')
    // And the invite call itself must not smuggle the role in via its `data`
    // option, which writes user_metadata. Without this, an implementation that
    // writes the role to BOTH stores passes every other assertion here.
    expect(calls.invited[0]!.options).not.toHaveProperty('data')
  })

  // The whole reason authUserId is nullable: staff.csv created 31 of these.
  it('adopts an existing account-less profile instead of creating a duplicate', async () => {
    const db = await getTestDb()
    const existing = await db.user.create({
      data: { email: NURSE.email, name: 'Imported Name', role: 'STAFF', profession: 'NURSE' },
    })
    const { port } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ userId: existing.id })
    expect(await db.user.count({ where: { email: NURSE.email } })).toBe(1)
    const profile = await db.user.findUniqueOrThrow({ where: { id: existing.id } })
    expect(profile.authUserId).toBe('uid-1')
  })

  it('refuses to re-invite somebody who already has an account', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: NURSE.email, name: 'Already In', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-existing' },
    })
    const { port, calls } = fakeAdmin()

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ code: 'ALREADY_CLAIMED' })
    expect(calls.invited).toHaveLength(0)
  })

  // Failing after the auth user exists would leave an orphan that can sign in
  // with no profile — currentSessionUser() returns null for it, so the person
  // gets a login that bounces them straight back out with no explanation.
  it('deletes the auth user if profile linking fails, leaving no orphan', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    // A second profile already owns this authUserId, so the unique index on
    // authUserId will reject the link.
    await db.user.create({
      data: { email: 'squatter@c.test', name: 'Squatter', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-1' },
    })

    const result = await inviteMember(db, port, NURSE)

    expect(result).toMatchObject({ code: 'INVALID_INPUT' })
    expect(calls.deleted).toEqual(['uid-1'])
  })
})

describe('resendInvite', () => {
  it('re-issues the email without creating a second profile', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    const { userId } = (await inviteMember(db, port, NURSE)) as { userId: number }

    const result = await resendInvite(db, port, userId, REDIRECT)

    expect(result).toEqual({ ok: true })
    expect(calls.invited).toHaveLength(2)
    expect(await db.user.count({ where: { email: NURSE.email } })).toBe(1)
  })

  it('refuses to resend to a member with no account', async () => {
    const db = await getTestDb()
    const profile = await db.user.create({
      data: { email: 'nobody@c.test', name: 'Nobody', role: 'STAFF', profession: 'NURSE' },
    })
    const { port } = fakeAdmin()

    expect(await resendInvite(db, port, profile.id, REDIRECT)).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('revokeInvite', () => {
  it('deletes the auth user and unlinks the profile, keeping the roster row', async () => {
    const db = await getTestDb()
    const { port, calls } = fakeAdmin()
    const { userId } = (await inviteMember(db, port, NURSE)) as { userId: number }

    const result = await revokeInvite(db, port, userId)

    expect(result).toEqual({ ok: true })
    expect(calls.deleted).toEqual(['uid-1'])
    const profile = await db.user.findUniqueOrThrow({ where: { id: userId } })
    // The person stays on the roster and can be re-invited; only the pending
    // account is withdrawn.
    expect(profile.authUserId).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/members/invite.test.ts`
Expected: FAIL — cannot resolve `@/lib/members/invite`.

- [ ] **Step 4: Implement the service**

Create `lib/members/invite.ts`:

```ts
import type { PrismaClient, Profession, Role } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'

/**
 * The slice of `supabase.auth.admin` this module uses.
 *
 * A narrow port rather than a `SupabaseClient` so the branching below —
 * adoption, re-invite refusal, orphan cleanup — is testable against an
 * in-memory fake. Mirrors `lib/seed/auth-accounts.ts`'s `AuthAdminPort`.
 */
export interface InviteAdminPort {
  inviteUserByEmail(
    email: string,
    options?: { redirectTo?: string },
  ): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  updateUserById(
    id: string,
    attrs: { app_metadata?: Record<string, unknown> },
  ): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  listUsers(): Promise<{ data: { users: { id: string; email?: string }[] }; error: unknown }>
  deleteUser(id: string): Promise<{ error: unknown }>
}

export interface InviteInput {
  email: string
  name: string
  role: Role
  profession: Profession | null
  /** Absolute URL the invite link lands on. Built from APP_URL by the caller. */
  redirectTo: string
}

export async function inviteMember(
  db: PrismaClient,
  admin: InviteAdminPort,
  input: InviteInput,
): Promise<{ userId: number } | AppError> {
  const email = input.email.trim().toLowerCase()

  const existing = await db.user.findUnique({ where: { email } })
  if (existing?.authUserId) {
    return createAppError('ALREADY_CLAIMED', 'That person already has an account.')
  }

  // Creates the auth user AND sends the email in one call — this is the only
  // way to make Supabase send mail, and the reason Supabase owns identity at
  // all (spec §1).
  const { data, error } = await admin.inviteUserByEmail(email, { redirectTo: input.redirectTo })
  if (error || !data.user) {
    return createAppError('INVALID_INPUT', 'Could not send that invite. Check the address and try again.')
  }
  const authUserId = data.user.id

  // A SECOND call, deliberately: inviteUserByEmail's own `data` option writes
  // user_metadata, which the user can rewrite. Role must live in app_metadata.
  const stamped = await admin.updateUserById(authUserId, {
    app_metadata: { role: input.role, profession: input.profession },
  })
  if (stamped.error) {
    await admin.deleteUser(authUserId)
    return createAppError('INVALID_INPUT', 'Could not complete that invite. Please try again.')
  }

  try {
    const profile = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: { authUserId, role: input.role, profession: input.profession },
        })
      : await db.user.create({
          data: { email, name: input.name, role: input.role, profession: input.profession, authUserId },
        })
    return { userId: profile.id }
  } catch {
    // Roll the auth user back. Leaving it would create an account that can
    // authenticate but has no profile — currentSessionUser() returns null for
    // it, so the person signs in successfully and is bounced straight back to
    // /login with nothing explaining why.
    await admin.deleteUser(authUserId)
    return createAppError('INVALID_INPUT', 'Could not link that invite to a roster record.')
  }
}

export async function resendInvite(
  db: PrismaClient,
  admin: InviteAdminPort,
  userId: number,
  redirectTo: string,
): Promise<{ ok: true } | AppError> {
  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile?.authUserId) {
    return createAppError('NOT_FOUND', 'That person has no pending invite.')
  }

  const { error } = await admin.inviteUserByEmail(profile.email, { redirectTo })
  // `email_exists` is the expected answer here — the auth user was created by
  // the original invite. Supabase still re-sends the mail, which is the point.
  if (error && (error as { code?: string }).code !== 'email_exists') {
    return createAppError('INVALID_INPUT', 'Could not resend that invite.')
  }
  return { ok: true }
}

export async function revokeInvite(
  db: PrismaClient,
  admin: InviteAdminPort,
  userId: number,
): Promise<{ ok: true } | AppError> {
  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile?.authUserId) {
    return createAppError('NOT_FOUND', 'That person has no pending invite.')
  }

  const { error } = await admin.deleteUser(profile.authUserId)
  if (error) return createAppError('INVALID_INPUT', 'Could not revoke that invite.')

  // The roster row survives with authUserId null — the person is still a real
  // staff member who can be re-invited; only the pending account is withdrawn.
  await db.user.update({ where: { id: userId }, data: { authUserId: null } })
  return { ok: true }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/members/invite.test.ts && npx tsc --noEmit`
Expected: PASS — 8 tests, type-clean.

- [ ] **Step 6: Commit**

```bash
git add lib/members/invite.ts lib/contracts/members.ts tests/members/invite.test.ts
git commit -m "feat(members): invite, resend and revoke against the Supabase admin API"
```

---

### Task 4: Deactivation with claim release

Offboarding. The claim release and the outbox events are the substance — a deactivation that leaves future claims in place makes the coverage dashboard lie about who is turning up.

**Files:**
- Create: `lib/members/deactivate.ts`
- Test: `tests/members/deactivate.test.ts` (create)
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `emitEvent` from `@/lib/events/outbox`, `weekTopic` from `@/lib/events/topics`, `TX_OPTIONS` from `@/lib/rules/assign`.
- Produces: `interface BanAdminPort { updateUserById(id, attrs: { ban_duration?: string }): Promise<{ error: unknown }> }` and
  `deactivateMember(db, admin, userId, opts?: { now?: Date }): Promise<{ releasedShiftIds: number[] } | AppError>`

- [ ] **Step 1: Write the failing tests**

Create `tests/members/deactivate.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deactivateMember, type BanAdminPort } from '@/lib/members/deactivate'
import { weekTopic } from '@/lib/events/topics'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

const NOW = new Date('2026-08-01T12:00:00Z')
const FUTURE = new Date('2026-08-10T09:00:00Z')
const PAST = new Date('2026-07-20T09:00:00Z')

function fakeAdmin() {
  const banned: { id: string; duration: unknown }[] = []
  const port: BanAdminPort = {
    updateUserById: (id, attrs) => {
      banned.push({ id, duration: attrs.ban_duration })
      return Promise.resolve({ error: null })
    },
  }
  return { port, banned }
}

async function seedMemberWithClaims() {
  const db = await getTestDb()
  const nurse = await db.user.create({
    data: { email: 'leaver@c.test', name: 'Leaver', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-leaver' },
  })
  const future = await db.shift.create({
    data: {
      startsAt: FUTURE, endsAt: new Date('2026-08-10T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  const past = await db.shift.create({
    data: {
      startsAt: PAST, endsAt: new Date('2026-07-20T17:00:00Z'),
      requirements: { create: [{ profession: 'NURSE', requiredCount: 2 }] },
    },
  })
  await db.claim.createMany({
    data: [
      { shiftId: future.id, userId: nurse.id },
      { shiftId: past.id, userId: nurse.id },
    ],
  })
  return { db, nurse, future, past }
}

describe('deactivateMember', () => {
  it('releases claims on shifts that have not started', async () => {
    const { db, nurse, future } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [future.id] })
    expect(await db.claim.count({ where: { shiftId: future.id, userId: nurse.id } })).toBe(0)
  })

  // History, not staffing. Deleting it would rewrite who worked a shift that
  // has already happened.
  it('keeps claims on shifts that have already started', async () => {
    const { db, nurse, past } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(await db.claim.count({ where: { shiftId: past.id, userId: nurse.id } })).toBe(1)
  })

  it('marks the profile deactivated and bans the Supabase user', async () => {
    const { db, nurse } = await seedMemberWithClaims()
    const { port, banned } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    const profile = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    expect(profile.deactivatedAt).toBeInstanceOf(Date)
    expect(banned).toHaveLength(1)
    expect(banned[0]!.id).toBe('uid-leaver')
  })

  // Without these, every open dashboard keeps showing the released slot as
  // filled until someone reloads — the exact thing realtime exists to prevent.
  // Asserted structurally, NOT with `JSON.stringify(...).toContain(id)`. That
  // shortcut cannot tell shiftId from userId (both are small integers from a
  // fresh container, so the digits collide), cannot see the topic at all, and
  // cannot see whether the payload matches the shape the UI actually reads.
  it('emits a claims_dropped event carrying the shape both consumers read', async () => {
    const { db, nurse, future } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    await deactivateMember(db, port, nurse.id, { now: NOW })

    const events = await db.eventOutbox.findMany({ where: { type: 'shift.claims_dropped' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      // Subscribers listen per week. Emitting on the CURRENT week rather than
      // the shift's would deliver into a topic nobody viewing that shift is
      // subscribed to — the event would vanish silently.
      topic: weekTopic(FUTURE),
      payload: {
        shiftId: future.id,
        dropped: [{
          userId: nurse.id,
          // `name` and `reason` are not decoration: app/(app)/shifts/[id]/page.tsx
          // renders `${d.name} was dropped — ${d.reason}` and my-shifts reads
          // `d.reason`. Omitting them renders "undefined was dropped — undefined".
          name: 'Leaver',
          profession: 'NURSE',
          code: 'NOT_CLAIMED',
          reason: expect.stringMatching(/deactivat/i),
        }],
      },
    })
  })

  it('emits no event when the member held no future shifts', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'idle@c.test', name: 'Idle', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-idle' },
    })
    const { port } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [] })
    expect(await db.eventOutbox.count({ where: { type: 'shift.claims_dropped' } })).toBe(0)
  })

  it('is idempotent — deactivating twice changes nothing the second time', async () => {
    const { db, nurse } = await seedMemberWithClaims()
    const { port } = fakeAdmin()

    const first = await deactivateMember(db, port, nurse.id, { now: NOW })
    const before = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })
    const second = await deactivateMember(db, port, nurse.id, { now: NOW })
    const after = await db.user.findUniqueOrThrow({ where: { id: nurse.id } })

    expect(first).toMatchObject({ releasedShiftIds: expect.any(Array) })
    expect(second).toMatchObject({ releasedShiftIds: [] })
    expect(after.deactivatedAt!.getTime()).toBe(before.deactivatedAt!.getTime())
  })

  it('refuses to deactivate somebody who does not exist', async () => {
    const db = await getTestDb()
    const { port } = fakeAdmin()
    expect(await deactivateMember(db, port, 999_999, { now: NOW })).toMatchObject({ code: 'NOT_FOUND' })
  })

  // A member invited but never accepted has no Supabase session to kill; the
  // profile mark alone is the whole job.
  it('deactivates an account-less profile without calling the admin API', async () => {
    const db = await getTestDb()
    const nurse = await db.user.create({
      data: { email: 'never@c.test', name: 'Never Invited', role: 'STAFF', profession: 'NURSE' },
    })
    const { port, banned } = fakeAdmin()

    const result = await deactivateMember(db, port, nurse.id, { now: NOW })

    expect(result).toMatchObject({ releasedShiftIds: [] })
    expect(banned).toHaveLength(0)
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.id } })).deactivatedAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/members/deactivate.test.ts`
Expected: FAIL — cannot resolve `@/lib/members/deactivate`.

- [ ] **Step 3: Implement it**

Create `lib/members/deactivate.ts`:

```ts
import type { PrismaClient } from '@prisma/client'
import { createAppError, type AppError } from '@/lib/domain/errors'
import { emitEvent } from '@/lib/events/outbox'
import { weekTopic } from '@/lib/events/topics'
import { TX_OPTIONS } from '@/lib/rules/assign'

/** The slice of `supabase.auth.admin` needed to revoke a session. */
export interface BanAdminPort {
  updateUserById(id: string, attrs: { ban_duration?: string }): Promise<{ error: unknown }>
}

/**
 * Supabase expects a Go duration string. `876000h` is 100 years — Supabase has
 * no "ban forever" value, and reactivation is a deliberate future feature
 * (unban + clear deactivatedAt) rather than something a clock should do.
 */
const BAN_FOREVER = '876000h'

export interface DeactivateResult {
  /** Shifts whose staffing changed, so the caller can report what reopened. */
  releasedShiftIds: number[]
}

/**
 * Offboards a member: revoke the session, mark the profile, release future
 * claims, and tell every open dashboard.
 *
 * The claim policy is a product decision recorded in DECISIONS.md — future
 * claims are released because a member who has left should stop appearing as
 * cover for shifts they will not work; past claims stay because they are
 * history and deleting them would rewrite who worked an already-finished shift.
 *
 * The ban happens BEFORE the transaction because `admin.updateUserById` is a
 * network call to another service and cannot join a Postgres transaction, so
 * one of the two orderings has to be chosen deliberately.
 *
 * Note what the choice is NOT about: a marked-but-unbanned member is already
 * locked out, because `currentSessionUser()` fails closed on `deactivatedAt`
 * on every request. The Supabase-level ban is defence in depth, not the lock.
 *
 * The real trade is which partial state is preferable if the process dies
 * between the two. Ban-first leaves a revoked account whose claims are still
 * held — visibly incomplete, and safe to re-run. Mark-first leaves the product
 * outcome fully achieved with only the redundant ban missing, which is
 * harmless but invisible, so nobody would ever retry it. Ban-first is chosen
 * for being the failure that announces itself.
 */
export async function deactivateMember(
  db: PrismaClient,
  admin: BanAdminPort,
  userId: number,
  opts: { now?: Date } = {},
): Promise<DeactivateResult | AppError> {
  const now = opts.now ?? new Date()

  const profile = await db.user.findUnique({ where: { id: userId } })
  if (!profile) return createAppError('NOT_FOUND', 'That person is not on the roster.')

  if (profile.authUserId) {
    const { error } = await admin.updateUserById(profile.authUserId, { ban_duration: BAN_FOREVER })
    if (error) return createAppError('INVALID_INPUT', 'Could not revoke that account’s access.')
  }

  return db.$transaction(async (tx) => {
    // Re-read inside the transaction: a concurrent deactivation must not
    // release the same claims twice or overwrite the original timestamp.
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (current.deactivatedAt) return { releasedShiftIds: [] }

    const doomed = await tx.claim.findMany({
      where: { userId, shift: { startsAt: { gt: now } } },
      select: { shiftId: true, shift: { select: { startsAt: true } } },
    })

    await tx.user.update({ where: { id: userId }, data: { deactivatedAt: now } })

    if (doomed.length > 0) {
      await tx.claim.deleteMany({ where: { userId, shiftId: { in: doomed.map((c) => c.shiftId) } } })

      // MUST match `DroppedClaim` from lib/rules/edit.ts:17-24. Two live
      // consumers destructure it — app/(app)/shifts/[id]/page.tsx:87 renders
      // `${d.name} was dropped — ${d.reason}` into the activity feed, and
      // app/(app)/my-shifts/page.tsx:152 reads `d.reason` into the drop
      // notice. Emitting a bare `{ userId }` type-checks (the payload is Json)
      // and renders "undefined was dropped — undefined".
      const dropped = [{
        userId: current.id,
        name: current.name,
        profession: current.profession,
        code: 'NOT_CLAIMED' as const,
        reason: 'They were removed from the roster.',
      }]

      for (const claim of doomed) {
        await emitEvent(tx, {
          // The SHIFT's week, not today's. Subscribers listen per week
          // (`weekTopic`), so an event on the wrong topic is delivered to
          // nobody watching that shift.
          topic: weekTopic(claim.shift.startsAt),
          type: 'shift.claims_dropped',
          payload: { shiftId: claim.shiftId, dropped },
        })
      }
    }

    return { releasedShiftIds: doomed.map((c) => c.shiftId) }
  }, TX_OPTIONS)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/members/deactivate.test.ts && npx tsc --noEmit`
Expected: PASS — 8 tests, type-clean.

- [ ] **Step 5: Record the decision**

Append to `DECISIONS.md`, matching the surrounding entries' style:

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add lib/members/deactivate.ts tests/members/deactivate.test.ts DECISIONS.md
git commit -m "feat(members): release future claims when a member is deactivated"
```

---

### Task 5: The members API

Four handlers wiring Tasks 2-4 to HTTP. `tests/rbac/routes.test.ts` will pick these up automatically and fail if any is unguarded.

**Files:**
- Create: `app/api/members/route.ts`, `app/api/members/[id]/route.ts`, `app/api/members/[id]/invite/route.ts`
- Test: `tests/api/members.test.ts` (create)

**Interfaces:**
- Consumes: `inviteMember`, `resendInvite`, `revokeInvite`, `deactivateMember`, `memberStatus`, `inviteMemberSchema`, `withAuth`, `errorResponse`, `createSupabaseAdminClient`.
- Produces: `GET /api/members` → `{ members: MemberRow[] }` where `MemberRow` is `{ id, name, email, role, profession, status }`; `POST /api/members` → `{ userId }`; `DELETE /api/members/[id]` → `{ releasedShiftIds }`; `POST|DELETE /api/members/[id]/invite` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/members.test.ts`, following the mock style of `tests/api/imports.test.ts` (read it first — it mocks `@/lib/auth/session` and reshapes a `session` variable per test):

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const session = vi.hoisted(() => ({
  user: null as null | { id: number; role: 'MANAGER' | 'STAFF'; profession: string | null; name: string; email: string },
}))

vi.mock('@/lib/auth/session', () => ({
  currentSessionUser: () =>
    Promise.resolve(
      session.user
        ? {
            authUserId: 'auth-uid',
            email: session.user.email,
            name: session.user.name,
            principal: { id: session.user.id, role: session.user.role, profession: session.user.profession },
          }
        : null,
    ),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

// The admin client is never constructed in unit tests — it would need a live
// GoTrue. Every route reaches it through this one factory, so stubbing here
// covers all four handlers.
const adminCalls = vi.hoisted(() => ({ invited: [] as string[], deleted: [] as string[], banned: [] as string[] }))
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: (email: string) => {
          adminCalls.invited.push(email)
          return Promise.resolve({ data: { user: { id: `uid-${adminCalls.invited.length}` } }, error: null })
        },
        updateUserById: (id: string, attrs: Record<string, unknown>) => {
          if ('ban_duration' in attrs) adminCalls.banned.push(id)
          return Promise.resolve({ data: { user: { id } }, error: null })
        },
        listUsers: () => Promise.resolve({ data: { users: [] }, error: null }),
        deleteUser: (id: string) => {
          adminCalls.deleted.push(id)
          return Promise.resolve({ error: null })
        },
      },
    },
  }),
}))

const { GET, POST } = await import('@/app/api/members/route')
const { DELETE: DEACTIVATE } = await import('@/app/api/members/[id]/route')

beforeEach(async () => {
  await resetTestDb()
  adminCalls.invited.length = 0
  adminCalls.deleted.length = 0
  adminCalls.banned.length = 0
  session.user = { id: 1, role: 'MANAGER', profession: null, name: 'Dana', email: 'dana@c.test' }
})
afterAll(stopTestDb)

function post(body: unknown) {
  return new Request('http://localhost/api/members', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

const VALID = { email: 'new@clinicmail.test', name: 'New Person', role: 'STAFF', profession: 'NURSE' }

describe('POST /api/members', () => {
  it('refuses a staff member with 403', async () => {
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(403)
  })

  it('refuses an unauthenticated request with 401', async () => {
    session.user = null
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('invites a new member for a manager', async () => {
    const res = await POST(post(VALID), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    expect(adminCalls.invited).toEqual(['new@clinicmail.test'])
  })

  it('rejects a staff invite with no profession as 400, not 500', async () => {
    const res = await POST(post({ ...VALID, profession: null }), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    expect(adminCalls.invited).toHaveLength(0)
  })

  it('rejects a malformed email as 400', async () => {
    const res = await POST(post({ ...VALID, email: 'not-an-email' }), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/members', () => {
  it('refuses a staff member with 403', async () => {
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }
    const res = await GET(new Request('http://localhost/api/members'), { params: Promise.resolve({}) })
    expect(res.status).toBe(403)
  })

  it('lists every roster member with a derived status', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'imported@c.test', name: 'Imported', role: 'STAFF', profession: 'NURSE' },
    })
    const res = await GET(new Request('http://localhost/api/members'), { params: Promise.resolve({}) })
    expect(res.status).toBe(200)
    const body = await res.json()
    const imported = body.members.find((m: { email: string }) => m.email === 'imported@c.test')
    expect(imported.status).toBe('no-account')
  })
})

describe('DELETE /api/members/[id]', () => {
  it('refuses a staff member with 403', async () => {
    const db = await getTestDb()
    const target = await db.user.create({
      data: { email: 't@c.test', name: 'T', role: 'STAFF', profession: 'NURSE' },
    })
    session.user = { id: 2, role: 'STAFF', profession: 'NURSE', name: 'Nina', email: 'nina@c.test' }

    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: String(target.id) }),
    })
    expect(res.status).toBe(403)
  })

  it('deactivates for a manager and reports released shifts', async () => {
    const db = await getTestDb()
    const target = await db.user.create({
      data: { email: 't@c.test', name: 'T', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-t' },
    })

    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: String(target.id) }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ releasedShiftIds: [] })
    expect(adminCalls.banned).toEqual(['uid-t'])
  })

  it('returns 400 for a non-numeric id rather than crashing', async () => {
    const res = await DEACTIVATE(new Request('http://localhost', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'abc' }),
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api/members.test.ts`
Expected: FAIL — cannot resolve `@/app/api/members/route`.

- [ ] **Step 3: Implement the list and invite handlers**

Create `app/api/members/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { getServerEnv } from '@/lib/config/env'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { inviteMemberSchema } from '@/lib/contracts/members'
import { inviteMember, type InviteAdminPort } from '@/lib/members/invite'
import { memberStatus } from '@/lib/members/status'

/**
 * Adapts supabase-js's admin API to the narrow ports the member services take.
 * Written out rather than cast: supabase-js's own return types are wider than
 * the ports and will not assign structurally, and an `as unknown as` would
 * survive a breaking change in the library silently.
 */
function adminPort(): InviteAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    inviteUserByEmail: async (email, options) => {
      const { data, error } = await admin.inviteUserByEmail(email, options)
      return { data: { user: data?.user ?? null }, error }
    },
    updateUserById: async (id, attrs) => {
      const { data, error } = await admin.updateUserById(id, attrs)
      return { data: { user: data?.user ?? null }, error }
    },
    listUsers: async () => {
      const { data, error } = await admin.listUsers({ perPage: 1000 })
      return { data: { users: data?.users ?? [] }, error }
    },
    deleteUser: async (id) => {
      const { error } = await admin.deleteUser(id)
      return { error }
    },
  }
}

export const GET = withAuth('member:read', async () => {
  const profiles = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, email: true, role: true, profession: true,
      authUserId: true, deactivatedAt: true,
    },
  })

  // One admin call joined in memory, rather than a stored status column that
  // would drift from Supabase the moment anyone touched the dashboard (§3.1).
  //
  // A FAILED call is not the same as "nobody has an account": swallowing the
  // error would render every member — including all four demo accounts — as
  // "No account", which is 35 rows of confident misinformation. Per-user
  // absence still degrades to no-account (see memberStatus); a whole-call
  // failure is an error.
  const { data, error } = await adminPort().listUsers()
  if (error) {
    return errorResponse(createAppError('BUSY', 'Could not reach the accounts service. Please try again.'))
  }
  const byId = new Map(data.users.map((u) => [u.id, u]))

  const members = profiles.map((p) => {
    const authUser = p.authUserId ? byId.get(p.authUserId) : undefined
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      profession: p.profession,
      status: memberStatus({
        authUserId: p.authUserId,
        deactivatedAt: p.deactivatedAt,
        authUser: authUser
          ? { confirmedAt: (authUser as { confirmed_at?: string }).confirmed_at
              ? new Date((authUser as { confirmed_at: string }).confirmed_at)
              : null }
          : null,
      }),
    }
  })

  return NextResponse.json({ members })
})

export const POST = withAuth('member:invite', async (req) => {
  const raw: unknown = await req.json().catch(() => null)
  const parsed = inviteMemberSchema.safeParse(raw)
  if (!parsed.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsed.error.issues[0]!.message))
  }

  const result = await inviteMember(prisma, adminPort(), {
    ...parsed.data,
    redirectTo: `${getServerEnv().appUrl}/auth/accept-invite`,
  })
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
```

- [ ] **Step 4: Implement the deactivate handler**

Create `app/api/members/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { deactivateMember, type BanAdminPort } from '@/lib/members/deactivate'

function banPort(): BanAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    updateUserById: async (id, attrs) => {
      const { error } = await admin.updateUserById(id, attrs)
      return { error }
    },
  }
}

export const DELETE = withAuth<{ id: string }>('member:manage', async (_req, { params, principal }) => {
  const { id } = await params
  const userId = Number(id)
  if (!Number.isInteger(userId) || userId <= 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))
  }

  // A manager who deactivates themselves would be locked out of the only page
  // that could undo it, with no other manager necessarily existing.
  if (userId === principal.id) {
    return errorResponse(createAppError('FORBIDDEN', 'You cannot deactivate your own account.'))
  }

  const result = await deactivateMember(prisma, banPort(), userId)
  if ('code' in result) return errorResponse(result)

  return NextResponse.json(result)
})
```

- [ ] **Step 5: Implement the resend/revoke handlers**

Create `app/api/members/[id]/invite/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { getServerEnv } from '@/lib/config/env'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { resendInvite, revokeInvite, type InviteAdminPort } from '@/lib/members/invite'

function adminPort(): InviteAdminPort {
  const admin = createSupabaseAdminClient().auth.admin
  return {
    inviteUserByEmail: async (email, options) => {
      const { data, error } = await admin.inviteUserByEmail(email, options)
      return { data: { user: data?.user ?? null }, error }
    },
    updateUserById: async (id, attrs) => {
      const { data, error } = await admin.updateUserById(id, attrs)
      return { data: { user: data?.user ?? null }, error }
    },
    listUsers: async () => {
      const { data, error } = await admin.listUsers({ perPage: 1000 })
      return { data: { users: data?.users ?? [] }, error }
    },
    deleteUser: async (id) => {
      const { error } = await admin.deleteUser(id)
      return { error }
    },
  }
}

function parseId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export const POST = withAuth<{ id: string }>('member:invite', async (_req, { params }) => {
  const userId = parseId((await params).id)
  if (userId === null) return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))

  const result = await resendInvite(
    prisma, adminPort(), userId, `${getServerEnv().appUrl}/auth/accept-invite`,
  )
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})

export const DELETE = withAuth<{ id: string }>('member:manage', async (_req, { params }) => {
  const userId = parseId((await params).id)
  if (userId === null) return errorResponse(createAppError('INVALID_INPUT', 'That is not a valid member id.'))

  const result = await revokeInvite(prisma, adminPort(), userId)
  if ('code' in result) return errorResponse(result)
  return NextResponse.json(result)
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/api/members.test.ts tests/rbac/routes.test.ts && npx tsc --noEmit`
Expected: PASS. `tests/rbac/routes.test.ts` now covers three additional route files and must find the `withAuth` brand on all six new handlers.

- [ ] **Step 7: Commit**

```bash
git add app/api/members tests/api/members.test.ts
git commit -m "feat(members): expose invite, resend, revoke and deactivate over HTTP"
```

---

### Task 6: The members page

Manager-only UI. The page itself is a Server Component that only renders; every mutation goes through Task 5's routes, which is what keeps `lib/supabase/admin.ts` out of any `.tsx` import graph.

**Files:**
- Create: `app/(app)/members/page.tsx`, `app/(app)/members/members-table.tsx`
- Modify: `components/app-shell.tsx:24-37`
- Test: `tests/ui/members-table.test.tsx` (create)

**Interfaces:**
- Consumes: `GET/POST /api/members`, `POST/DELETE /api/members/[id]/invite`, `DELETE /api/members/[id]`, `currentSessionUser`, `can`.
- Produces: no exports other modules depend on.

- [ ] **Step 1: Write the failing component test**

Create `tests/ui/members-table.test.tsx`. Follow `tests/ui/import-upload-form.test.tsx` for conventions (read it first — note the `/** @vitest-environment jsdom */` pragma):

```tsx
/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MembersTable } from '@/app/(app)/members/members-table'

const MEMBERS = [
  { id: 1, name: 'Dana Okonkwo', email: 'dana@c.test', role: 'MANAGER' as const, profession: null, status: 'active' as const },
  { id: 2, name: 'Ivy Bell', email: 'ivy@c.test', role: 'STAFF' as const, profession: 'NURSE' as const, status: 'invited' as const },
  { id: 3, name: 'Imported Person', email: 'imp@c.test', role: 'STAFF' as const, profession: 'DOCTOR' as const, status: 'no-account' as const },
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))))
})

describe('MembersTable', () => {
  it('shows every member with their status', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    expect(screen.getByText('Dana Okonkwo')).toBeInTheDocument()
    expect(screen.getByText('Imported Person')).toBeInTheDocument()
    expect(screen.getByText(/no account/i)).toBeInTheDocument()
  })

  // The population the invite feature exists for — 31 of them at seed time.
  it('offers to invite somebody who has no account yet', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const row = screen.getByText('Imported Person').closest('tr')!
    expect(within(row).getByRole('button', { name: /invite/i })).toBeInTheDocument()
  })

  it('offers resend and revoke for a pending invite, not for an active member', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const pending = screen.getByText('Ivy Bell').closest('tr')!
    expect(within(pending).getByRole('button', { name: /resend/i })).toBeInTheDocument()
    expect(within(pending).getByRole('button', { name: /revoke/i })).toBeInTheDocument()

    const active = screen.getByText('Dana Okonkwo').closest('tr')!
    expect(within(active).queryByRole('button', { name: /resend/i })).toBeNull()
  })

  // Locking yourself out of the only page that could undo it.
  it('does not offer to deactivate yourself', () => {
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)
    const self = screen.getByText('Dana Okonkwo').closest('tr')!
    expect(within(self).queryByRole('button', { name: /deactivate/i })).toBeNull()
  })

  it('posts the invite form to the API', async () => {
    const user = userEvent.setup()
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)

    await user.type(screen.getByLabelText(/email/i), 'fresh@c.test')
    await user.type(screen.getByLabelText(/name/i), 'Fresh Face')
    await user.click(screen.getByRole('button', { name: /send invite/i }))

    expect(fetch).toHaveBeenCalledWith('/api/members', expect.objectContaining({ method: 'POST' }))
  })

  it('surfaces a server error inline rather than silently failing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'ALREADY_CLAIMED', message: 'That person already has an account.' } }),
      { status: 409 },
    ))))
    const user = userEvent.setup()
    render(<MembersTable initialMembers={MEMBERS} currentUserId={1} />)

    await user.type(screen.getByLabelText(/email/i), 'dupe@c.test')
    await user.type(screen.getByLabelText(/name/i), 'Dupe')
    await user.click(screen.getByRole('button', { name: /send invite/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an account/i)
  })
})
```

Add `within` to the `@testing-library/react` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ui/members-table.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Build the client component**

Create `app/(app)/members/members-table.tsx` as a `'use client'` component exporting `MembersTable({ initialMembers, currentUserId })`.

Requirements it must satisfy, all asserted by Step 1's tests:
- A table with one row per member showing name, email, role, profession and a human-readable status label — "Active", "Invited", "Deactivated", "No account".
- An invite form above the table with labelled `Email` and `Name` inputs, a role select (Manager/Staff) and a profession select, and a `Send invite` submit button. The profession select is disabled when Manager is chosen, matching `inviteMemberSchema`'s refinement.
- Per-row buttons, conditional on status: `Invite` when `no-account`; `Resend` and `Revoke` when `invited`; `Deactivate` when `active` or `invited`, except on the row whose `id === currentUserId`.
- Every mutation is a `fetch` to the Task 5 endpoints. On a non-2xx response, read `body.error.message` and render it in an element with `role="alert"`. On success, re-fetch `GET /api/members` and replace the rows.
- Buttons disable while their request is in flight.

Follow `components/import/import-upload-form.tsx` for the fetch-and-render-error idiom, and use `@/components/ui/*` primitives (`Button`, `Input`, `Badge`) so it matches the rest of the app.

- [ ] **Step 4: Build the page and the nav entry**

Create `app/(app)/members/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PageHero } from '@/components/page-hero'
import { currentSessionUser } from '@/lib/auth/session'
import { can } from '@/lib/auth/permissions'
import { prisma } from '@/lib/db/client'
import { MembersTable } from './members-table'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Members — MedRoster' }

/**
 * Manager-only. Renders the roster; every mutation goes through
 * `app/api/members/*`, which is what keeps `lib/supabase/admin.ts` (and the
 * service-role key) out of this file's import graph — a `.tsx` is treated as
 * client-reachable by tests/auth/admin-containment.test.ts, transitively.
 *
 * The status column is deliberately NOT derived here: it needs the Supabase
 * admin API, so the client fetches it from GET /api/members on mount.
 */
export default async function MembersPage() {
  const session = await currentSessionUser()
  if (!session) notFound()
  if (!can(session.principal, 'member:read')) notFound()

  const profiles = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, email: true, role: true, profession: true },
  })

  // Rendered immediately with an optimistic 'active'; MembersTable replaces
  // these with real statuses from GET /api/members on mount, so the page is
  // useful before the admin round-trip completes.
  const initialMembers = profiles.map((p) => ({ ...p, status: 'active' as const }))

  return (
    <div className="space-y-6">
      <PageHero eyebrow="Team" title="Members">
        Invite colleagues, chase pending invites, and offboard people who have left.
      </PageHero>
      <MembersTable initialMembers={initialMembers} currentUserId={session.principal.id} />
    </div>
  )
}
```

In `components/app-shell.tsx`, add to the nav array (after the Import entry, line 37):

```tsx
  { href: '/members', label: 'Members', permission: 'member:read' },
```

- [ ] **Step 5: Extend the middleware matcher**

In `middleware.ts`, add `/members` to the `config.matcher` array so an unauthenticated request is redirected before the page renders. (There is no `isApp` helper — the merged middleware gates purely on the matcher.)

```ts
export const config = {
  matcher: ['/dashboard/:path*', '/shifts/:path*', '/my-shifts/:path*', '/import/:path*', '/members/:path*'],
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/ui/members-table.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS — 6 tests, type-clean, lint-clean.

- [ ] **Step 7: Verify containment did not regress**

Run: `npx vitest run tests/auth/admin-containment.test.ts`
Expected: PASS. This is the specific risk of this task — if it fails, `members/page.tsx` or `members-table.tsx` has picked up a path to `lib/supabase/admin.ts` and the fix is to move that work into a route handler, never to weaken the test.

- [ ] **Step 8: Commit**

```bash
git add "app/(app)/members" components/app-shell.tsx middleware.ts tests/ui/members-table.test.tsx
git commit -m "feat(members): add the manager-only members page"
```

---

### Task 7: Make emailed links deliver a server-readable session

**This task exists because of a measurement, not a guess.** Before writing it, a real invite was sent through the live local stack and the emailed link was followed:

```
GET http://127.0.0.1:54321/auth/v1/verify?token=…&type=invite&redirect_to=…
→ 303 See Other
   Location: http://127.0.0.1:3000#access_token=eyJ…&refresh_token=…&type=invite
```

Two things fall out of that, and both would have broken the screens in Task 8:

1. **The tokens arrive in the URL _fragment_.** Fragments are never sent to the server, so a Server Component calling `supabase.auth.getUser()` sees no session and would render "this link is not valid" for **every valid invite**.
2. **`redirect_to` was ignored** — the link landed on `site_url`, not the requested path — because `supabase/config.toml` allow-lists `https://127.0.0.1:3000` while the app serves `http://localhost:3000`. An exact-match allow-list miss silently falls back.

The fix is Supabase's documented SSR flow: switch the email templates to `{{ .TokenHash }}` and add a server route that exchanges the hash for a cookie session with `verifyOtp`. This task lands that plumbing before anything depends on it.

**Files:**
- Modify: `supabase/config.toml`
- Create: `supabase/templates/invite.html`, `supabase/templates/recovery.html`, `supabase/templates/magic-link.html`
- Create: `app/auth/confirm/route.ts`
- Test: `tests/auth/confirm.test.ts` (create)

**Interfaces:**
- Consumes: `createSupabaseServerClient`, `checkRosterByEmail` (Task 1).
- Produces: `GET /auth/confirm?token_hash=…&type=…&next=…` → redirect, having set the session cookie.

- [ ] **Step 1: Fix the redirect allow-list**

In `supabase/config.toml` under `[auth]`, replace the `additional_redirect_urls` line:

```toml
site_url = "http://localhost:3000"
# EXACT match, and the scheme counts. This previously read
# "https://127.0.0.1:3000" while the app serves http://localhost:3000, so every
# redirect_to was silently rejected and fell back to site_url — which is why an
# invite landed on / instead of /auth/accept-invite.
additional_redirect_urls = ["http://localhost:3000/**", "http://127.0.0.1:3000/**"]
```

- [ ] **Step 2: Switch the email templates to a server-readable token**

Create `supabase/templates/invite.html`:

```html
<h2>You have been invited to MedRoster</h2>
<p>A manager has invited you to join the clinic roster. Follow the link below to set a password and get started.</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/accept-invite">Accept the invitation</a></p>
<p>If you were not expecting this, you can ignore this email.</p>
```

Create `supabase/templates/recovery.html`:

```html
<h2>Reset your MedRoster password</h2>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/reset-password">Choose a new password</a></p>
<p>If you did not ask for this, you can ignore this email — your password will not change.</p>
```

Create `supabase/templates/magic-link.html`:

```html
<h2>Sign in to MedRoster</h2>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink&next=/dashboard">Sign in</a></p>
<p>If you did not ask for this, you can ignore this email.</p>
```

`{{ .TokenHash }}` rather than the default `{{ .ConfirmationURL }}` is the whole point: `.ConfirmationURL` sends the recipient to GoTrue's `/verify`, which answers with fragment tokens the server cannot read. A token hash is a query parameter our own route can exchange.

Register them in `supabase/config.toml`:

```toml
[auth.email.template.invite]
subject = "You have been invited to MedRoster"
content_path = "./supabase/templates/invite.html"

[auth.email.template.recovery]
subject = "Reset your MedRoster password"
content_path = "./supabase/templates/recovery.html"

[auth.email.template.magic_link]
subject = "Sign in to MedRoster"
content_path = "./supabase/templates/magic-link.html"
```

- [ ] **Step 3: Write the failing tests**

Create `tests/auth/confirm.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const verified = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  error: null as null | { message: string },
  calls: [] as { type: string; token_hash: string }[],
}))
const signOut = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: {
        verifyOtp: (args: { type: string; token_hash: string }) => {
          verified.calls.push(args)
          return Promise.resolve({ data: { user: verified.user }, error: verified.error })
        },
        signOut,
      },
    }),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { GET } = await import('@/app/auth/confirm/route')

beforeEach(async () => {
  await resetTestDb()
  verified.error = null
  verified.calls.length = 0
  signOut.mockReset()
})
afterAll(stopTestDb)

const url = (params: Record<string, string>) =>
  new Request(`http://localhost/auth/confirm?${new URLSearchParams(params)}`)

async function seedMember(over: Partial<{ authUserId: string | null; deactivatedAt: Date | null }> = {}) {
  const db = await getTestDb()
  return db.user.create({
    data: {
      email: 'ivy@c.test', name: 'Ivy', role: 'STAFF', profession: 'NURSE',
      authUserId: 'uid-ivy', deactivatedAt: null, ...over,
    },
  })
}

/** Decodes the `error` query param, which URLSearchParams encodes spaces as `+`. */
function errorOf(res: Response): string | null {
  return new URL(res.headers.get('location')!).searchParams.get('error')
}

describe('GET /auth/confirm', () => {
  it('exchanges the token hash and forwards to the requested next path', async () => {
    await seedMember()
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'hash-1', type: 'invite', next: '/auth/accept-invite' }))

    expect(verified.calls).toEqual([{ type: 'invite', token_hash: 'hash-1' }])
    expect(new URL(res.headers.get('location')!).pathname).toBe('/auth/accept-invite')
  })

  // The same roster gate as every other entry point: a link is not authority.
  it('refuses a member who was deactivated after the link was sent', async () => {
    await seedMember({ deactivatedAt: new Date() })
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'recovery', next: '/auth/reset-password' }))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/no longer active/i)
    expect(signOut).toHaveBeenCalled()
  })

  it('refuses a profile that was never invited', async () => {
    await seedMember({ authUserId: null })
    verified.user = { id: 'uid-new', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'magiclink', next: '/dashboard' }))

    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
  })

  it('reports an expired or reused link instead of failing silently', async () => {
    verified.user = null
    verified.error = { message: 'Token has expired or is invalid' }

    const res = await GET(url({ token_hash: 'stale', type: 'invite', next: '/auth/accept-invite' }))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/expired/i)
  })

  it('rejects a missing token hash', async () => {
    const res = await GET(url({ type: 'invite' }))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(verified.calls).toHaveLength(0)
  })

  it('rejects an unknown otp type rather than passing it through', async () => {
    const res = await GET(url({ token_hash: 'h', type: 'not-a-type', next: '/dashboard' }))
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(verified.calls).toHaveLength(0)
  })

  // `next` comes from an email we generated, but the route is publicly
  // reachable and the parameter is attacker-controllable in a crafted link.
  // Same open-redirect class that bit the login action in Plan 1.
  it('ignores an off-origin next parameter', async () => {
    await seedMember()
    verified.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(url({ token_hash: 'h', type: 'invite', next: 'https://evil.example/' }))

    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('http://localhost')
    expect(location.pathname).toBe('/dashboard')
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/auth/confirm.test.ts`
Expected: FAIL — cannot resolve `@/app/auth/confirm/route`.

- [ ] **Step 5: Implement the route**

Create `app/auth/confirm/route.ts`:

```ts
import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { prisma } from '@/lib/db/client'
import { checkRosterByEmail } from '@/lib/auth/roster-gate'
import { safeNextPath } from '@/lib/auth/safe-redirect'
import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * Turns an emailed link into a cookie session the server can read.
 *
 * Measured, not assumed: GoTrue's default `{{ .ConfirmationURL }}` points at
 * its own `/verify`, which answers `303` with the tokens in the URL
 * **fragment** (`#access_token=…`). Fragments never reach the server, so a
 * Server Component reading `getUser()` would see nothing and reject every
 * valid link. Our templates therefore send `{{ .TokenHash }}` to this route,
 * which exchanges it with `verifyOtp` and sets the cookie before redirecting.
 *
 * The roster gate runs here too. A link is evidence that someone controls an
 * inbox, not that they are still a member — an invite sent last week to
 * somebody since deactivated must not become a session.
 */
const ALLOWED_TYPES = new Set<EmailOtpType>(['invite', 'recovery', 'magiclink', 'email', 'email_change'])

function isAllowedType(value: string | null): value is EmailOtpType {
  return value !== null && ALLOWED_TYPES.has(value as EmailOtpType)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type')
  // Same confinement as the login action's `next` (lib/auth/safe-redirect.ts):
  // this route is publicly reachable and the parameter is attacker-supplied in
  // a crafted link, so it must never become an off-origin redirect.
  const next = safeNextPath(url.searchParams.get('next'))

  const deny = (reason: string) => {
    const target = new URL('/login', url.origin)
    target.searchParams.set('error', reason)
    return NextResponse.redirect(target)
  }

  if (!tokenHash || !isAllowedType(type)) {
    return deny('That link is not valid. Please request a new one.')
  }

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
  if (error || !data.user?.email) {
    return deny('That link has expired or has already been used. Please request a new one.')
  }

  const profile = await prisma.user.findUnique({
    where: { email: data.user.email.toLowerCase() },
    select: { deactivatedAt: true, authUserId: true },
  })

  // An invite link is the one case where the profile legitimately has no
  // authUserId yet at gate time — inviteMember links it, so by the time the
  // link is clicked it is set. If it is genuinely absent the invite was
  // revoked, and refusing is correct.
  const gate = checkRosterByEmail(profile)
  if (!gate.allowed) {
    await supabase.auth.signOut()
    return deny(gate.reason)
  }

  return NextResponse.redirect(new URL(next, url.origin))
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/auth/confirm.test.ts && npx tsc --noEmit`
Expected: PASS — 7 tests, type-clean.

- [ ] **Step 7: Verify against the live stack**

Restart so the config and templates load, then send a real invite and follow the link:

```bash
npx supabase stop && npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,supavisor,storage-api,postgres-meta
```

Invite an address via the admin API, then read the email out of Mailpit:

```bash
KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d= -f2)
ADDR="confirm-check-$(date +%s)@clinicmail.test"
curl -s -X POST "http://127.0.0.1:54321/auth/v1/invite" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADDR\"}" >/dev/null
curl -s "http://127.0.0.1:54324/api/v1/search?query=to%3A$ADDR" | grep -o 'token_hash=[^&"]*' | head -1
```

Expected: the email now contains a `token_hash=` link pointing at `/auth/confirm`, **not** a `/auth/v1/verify` link. If it still shows `/auth/v1/verify`, the template did not load — check `content_path` is relative to the repo root and that `supabase start` was actually restarted.

- [ ] **Step 8: Commit**

```bash
git add supabase/config.toml supabase/templates app/auth/confirm tests/auth/confirm.test.ts
git commit -m "feat(auth): exchange emailed token hashes for a server-side session"
```

---

### Task 8: Accept invite, forgot password, reset password

The three public auth screens. Grouped because they share one mechanism — Task 7's `/auth/confirm` has already established a cookie session by the time these render, so each is a form that calls `updateUser({ password })` — and splitting them would triple the same scaffolding.

**Files:**
- Create: `app/auth/accept-invite/page.tsx`, `app/auth/reset-password/page.tsx`, `app/forgot-password/page.tsx`
- Create: `app/auth/set-password-form.tsx` (shared client component)
- Test: `tests/ui/set-password-form.test.tsx` (create)

**Interfaces:**
- Consumes: `createSupabaseBrowserClient` from `@/lib/supabase/browser`.
- Produces: `SetPasswordForm({ heading, submitLabel, redirectTo })` — a client component.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/set-password-form.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SetPasswordForm } from '@/app/auth/set-password-form'

const updateUser = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({ auth: { updateUser } }),
}))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

beforeEach(() => {
  updateUser.mockReset().mockResolvedValue({ error: null })
  push.mockReset()
})

describe('SetPasswordForm', () => {
  it('rejects a password shorter than 8 characters without calling Supabase', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'short')
    await user.type(screen.getByLabelText(/confirm/i), 'short')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects a mismatched confirmation without calling Supabase', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-hose')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('sets the password and redirects on success', async () => {
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-battery')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(updateUser).toHaveBeenCalledWith({ password: 'correct-horse-battery' })
    expect(push).toHaveBeenCalledWith('/dashboard')
  })

  // An expired or already-used link is the single most common real failure
  // here, and it must say so rather than showing a blank form that never works.
  it('surfaces a Supabase error instead of redirecting', async () => {
    updateUser.mockResolvedValue({ error: { message: 'Auth session missing!' } })
    const user = userEvent.setup()
    render(<SetPasswordForm heading="Set your password" submitLabel="Save" redirectTo="/dashboard" />)

    await user.type(screen.getByLabelText(/^new password/i), 'correct-horse-battery')
    await user.type(screen.getByLabelText(/confirm/i), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: /save/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/link may have expired/i)
    expect(push).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ui/set-password-form.test.tsx`
Expected: FAIL — cannot resolve `@/app/auth/set-password-form`.

- [ ] **Step 3: Build the shared form**

Create `app/auth/set-password-form.tsx` as a `'use client'` component exporting
`SetPasswordForm({ heading, submitLabel, redirectTo }: { heading: string; submitLabel: string; redirectTo: string })`.

Behaviour, all asserted above:
- Two labelled password inputs: `New password` and `Confirm password`, both `autoComplete="new-password"`.
- Client-side checks before any network call: minimum 8 characters ("Use at least 8 characters."), and the two must match ("Those passwords do not match."). Render failures in a `role="alert"` element.
- On valid input call `createSupabaseBrowserClient().auth.updateUser({ password })`.
- On `{ error }`, render "We could not set your password — the link may have expired. Ask a manager to resend your invite." in the alert. Do not redirect.
- On success, `router.push(redirectTo)`.
- Disable the submit button while in flight.

- [ ] **Step 4: Test the accept-invite branch**

The branch below decides whether a member ever sees a password screen, and an untested branch in a Server Component is exactly the gap Fable flagged. Extract it so it can be tested without rendering:

Create `app/auth/invite-branch.ts`:

```ts
/** The `identities` array Supabase returns on a user, narrowed to what matters. */
export interface IdentityLike { provider: string }

/**
 * Whether this member still needs to set a password.
 *
 * False for someone who accepted via Google: identity linking removes the
 * unconfirmed email identity, so they have no password and nothing to set.
 * Showing them a set-password form would strand them on a screen that cannot
 * succeed (spec §5.4.2).
 */
export function needsPassword(identities: IdentityLike[] | null | undefined): boolean {
  return (identities ?? []).some((i) => i.provider === 'email')
}
```

Create `tests/auth/invite-branch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { needsPassword } from '@/app/auth/invite-branch'

describe('needsPassword', () => {
  it('is true for an invitee who arrived by email link', () => {
    expect(needsPassword([{ provider: 'email' }])).toBe(true)
  })

  it('is false for an invitee who accepted via Google', () => {
    expect(needsPassword([{ provider: 'google' }])).toBe(false)
  })

  it('is true when both identities are present, so a password can still be set', () => {
    expect(needsPassword([{ provider: 'google' }, { provider: 'email' }])).toBe(true)
  })

  it('is false for a missing or empty identities array', () => {
    expect(needsPassword(null)).toBe(false)
    expect(needsPassword(undefined)).toBe(false)
    expect(needsPassword([])).toBe(false)
  })
})
```

Run: `npx vitest run tests/auth/invite-branch.test.ts` — expect FAIL, then PASS once `invite-branch.ts` exists.

- [ ] **Step 5: Build the three pages**

`app/auth/accept-invite/page.tsx` — Server Component. **By the time this renders, Task 7's `/auth/confirm` has already exchanged the token hash and set the session cookie**, so `getUser()` genuinely returns the invitee. (Before Task 7 existed, the tokens arrived in the URL fragment and this page could never have seen them — see Task 7's opening note.)

```tsx
const supabase = await createSupabaseServerClient()
const { data } = await supabase.auth.getUser()

// No session means the link was never exchanged, or it expired before it was
// clicked. /auth/confirm redirects failures to /login with a reason, so
// reaching here without a user means someone opened this URL directly.
if (!data.user) { /* render: "This invite link is no longer valid. Ask a manager to resend it." */ }

if (!needsPassword(data.user.identities)) redirect('/dashboard')

return <SetPasswordForm heading="Set your password" submitLabel="Set password and continue" redirectTo="/dashboard" />
```

`app/auth/reset-password/page.tsx` — the same shape, with heading "Choose a new password" and `submitLabel="Save new password"`. Its session also comes from `/auth/confirm` (the recovery template points there with `type=recovery`), so this page never parses a token itself.

`app/forgot-password/page.tsx` — a public form with one labelled `Email` input and a `Send reset link` button, calling
`createSupabaseBrowserClient().auth.resetPasswordForEmail(email, { redirectTo: '<origin>/auth/reset-password' })`.

**The response must be identical whether or not the address exists** — always render "If that address is on the roster, a reset link is on its way." Anything else turns this page into a way to enumerate which addresses are staff.

Add a "Forgot your password?" link to `app/login/login-form.tsx` pointing at `/forgot-password`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/ui/set-password-form.test.tsx tests/auth/invite-branch.test.ts && npx tsc --noEmit`
Expected: PASS — 4 + 4 tests, type-clean.

- [ ] **Step 7: Commit**

```bash
git add app/auth app/forgot-password app/login/login-form.tsx tests/ui/set-password-form.test.tsx tests/auth/invite-branch.test.ts
git commit -m "feat(auth): accept invite, forgot password and reset password screens"
```

---

### Task 9: Change password while signed in

Small, but it carries a real security requirement that is easy to miss.

**Files:**
- Create: `app/(app)/account/page.tsx`, `app/(app)/account/change-password-form.tsx`
- Test: `tests/ui/change-password-form.test.tsx` (create)

**Interfaces:**
- Consumes: `createSupabaseBrowserClient`.
- Produces: `ChangePasswordForm({ email, hasPassword }: { email: string; hasPassword: boolean })` — a client component.

**`hasPassword` is load-bearing, not a convenience flag.** Spec §5.4.2 promises a Google-linked member "can add a password later from account settings — `updateUser` adds one where none exists — but is never blocked on doing so." Such a member has *no* current password, so an unconditional `signInWithPassword` verification would fail every time and lock them out of the feature the spec guarantees them. The page derives it from the user's identities and the form branches on it.

- [ ] **Step 1: Write the failing test**

Create `tests/ui/change-password-form.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangePasswordForm } from '@/app/(app)/account/change-password-form'

const signInWithPassword = vi.hoisted(() => vi.fn())
const updateUser = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/browser', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signInWithPassword, updateUser } }),
}))

beforeEach(() => {
  signInWithPassword.mockReset().mockResolvedValue({ error: null })
  updateUser.mockReset().mockResolvedValue({ error: null })
})

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  await user.type(screen.getByLabelText(/current password/i), current)
  await user.type(screen.getByLabelText(/^new password/i), next)
  await user.type(screen.getByLabelText(/confirm/i), next)
  await user.click(screen.getByRole('button', { name: /change password/i }))
}

describe('ChangePasswordForm', () => {
  // The requirement that is easy to miss: Supabase's updateUser does NOT ask
  // for the current password, so without this check an unattended signed-in
  // browser is enough to take over the account.
  it('verifies the current password before changing it', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" hasPassword />)

    await fillAndSubmit(user, 'old-password', 'brand-new-password')

    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'ivy@c.test', password: 'old-password' })
    expect(updateUser).toHaveBeenCalledWith({ password: 'brand-new-password' })
  })

  it('does not change the password when the current one is wrong', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" hasPassword />)

    await fillAndSubmit(user, 'wrong', 'brand-new-password')

    expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects a short new password before touching the network', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" hasPassword />)

    await fillAndSubmit(user, 'old-password', 'short')

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i)
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('confirms success in place', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="ivy@c.test" hasPassword />)

    await fillAndSubmit(user, 'old-password', 'brand-new-password')

    expect(await screen.findByRole('status')).toHaveTextContent(/password changed/i)
  })
})

/**
 * Spec §5.4.2: a member who accepted their invite via Google has no password —
 * identity linking removed the unconfirmed email identity — and must still be
 * able to ADD one. Verifying a current password they do not have would fail
 * every time and lock them out of the feature the spec promises them.
 */
describe('ChangePasswordForm for a member with no password yet', () => {
  it('does not ask for a current password', () => {
    render(<ChangePasswordForm email="google@c.test" hasPassword={false} />)
    expect(screen.queryByLabelText(/current password/i)).toBeNull()
  })

  it('sets the password without a verification round-trip', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="google@c.test" hasPassword={false} />)

    await user.type(screen.getByLabelText(/^new password/i), 'brand-new-password')
    await user.type(screen.getByLabelText(/confirm/i), 'brand-new-password')
    await user.click(screen.getByRole('button', { name: /set password/i }))

    expect(signInWithPassword).not.toHaveBeenCalled()
    expect(updateUser).toHaveBeenCalledWith({ password: 'brand-new-password' })
  })

  it('still enforces the length and confirmation rules', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm email="google@c.test" hasPassword={false} />)

    await user.type(screen.getByLabelText(/^new password/i), 'short')
    await user.type(screen.getByLabelText(/confirm/i), 'short')
    await user.click(screen.getByRole('button', { name: /set password/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i)
    expect(updateUser).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ui/change-password-form.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Build the form and page**

Create `app/(app)/account/change-password-form.tsx` — a `'use client'` component taking `{ email }`, with three labelled inputs (`Current password`, `New password`, `Confirm new password`) and a `Change password` button.

Order of operations, which is the point of the component:
1. Validate locally: new password ≥ 8 characters, confirmation matches. Render failures in `role="alert"`.
2. Call `signInWithPassword({ email, password: currentPassword })`. On error render "Your current password is incorrect." and **stop** — do not call `updateUser`.
3. Call `updateUser({ password: newPassword })`. On error render its message.
4. On success render "Password changed." in a `role="status"` element and clear the inputs.

Add this comment above step 2, because a future reader will otherwise see it as a redundant round-trip:

```tsx
// Supabase's updateUser does NOT require the current password — a valid
// session is enough. Re-verifying it here is what stops an unattended
// signed-in browser from being a full account takeover. Do not "optimise"
// this call away.
```

Create `app/(app)/account/page.tsx` — a Server Component that resolves `currentSessionUser()`, calls `notFound()` when absent, and renders `<ChangePasswordForm email={session.email} />` under a `PageHero`. Add an `Account` link to the user menu in `components/user-menu.tsx` pointing at `/account`, and add `/account` to `middleware.ts`'s matcher.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ui/change-password-form.test.tsx && npx tsc --noEmit`
Expected: PASS — 4 tests, type-clean.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/account" components/user-menu.tsx middleware.ts tests/ui/change-password-form.test.tsx
git commit -m "feat(auth): change password while signed in, gated on the current one"
```

---

### Task 10: The OAuth/magic-link callback and the roster gate

The security-critical task. Under invite-only, a passwordless sign-in button is a hole unless something checks the identity against the roster first.

**Files:**
- Create: `app/auth/callback/route.ts`
- Modify: `app/login/login-form.tsx`
- Test: `tests/auth/callback.test.ts` (create)

**Interfaces:**
- Consumes: `checkRosterByEmail` (Task 1), `safeNextPath` (merged in Plan 1), `createSupabaseServerClient`, `createSupabaseAdminClient`.
- Produces: `GET /auth/callback` → a redirect.

- [ ] **Step 1: Write the failing tests**

Create `tests/auth/callback.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

const exchanged = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  error: null as null | { message: string },
}))
const signOut = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: {
        exchangeCodeForSession: () =>
          Promise.resolve({ data: { user: exchanged.user }, error: exchanged.error }),
        signOut,
      },
    }),
}))

const deleted = vi.hoisted(() => [] as string[])
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({
    auth: { admin: { deleteUser: (id: string) => { deleted.push(id); return Promise.resolve({ error: null }) } } },
  }),
}))

vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

const { GET } = await import('@/app/auth/callback/route')

beforeEach(async () => {
  await resetTestDb()
  signOut.mockReset()
  deleted.length = 0
  exchanged.error = null
})
afterAll(stopTestDb)

const req = () => new Request('http://localhost/auth/callback?code=abc123')

/**
 * Reads the `error` param back out, DECODED.
 *
 * `URLSearchParams.set` encodes spaces as `+`, so the raw Location header reads
 * `?error=This+account+is+no+longer+active.` and a regex like
 * `/no longer active/i` tested against the raw string fails — against a
 * perfectly correct implementation. Verified directly. Asserting on the decoded
 * value is the difference between a test that pins behaviour and one that
 * pressures the next engineer into weakening it.
 */
function errorOf(res: Response): string | null {
  return new URL(res.headers.get('location')!).searchParams.get('error')
}

describe('GET /auth/callback', () => {
  it('lets an active, invited member through to the dashboard', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'ivy@c.test', name: 'Ivy', role: 'STAFF', profession: 'NURSE', authUserId: 'uid-ivy' },
    })
    exchanged.user = { id: 'uid-ivy', email: 'ivy@c.test' }

    const res = await GET(req())

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/dashboard')
    expect(signOut).not.toHaveBeenCalled()
  })

  // The hole this route exists to close: a Google identity for an address
  // nobody invited must not become an account.
  it('refuses an identity with no roster profile, and deletes the orphan account', async () => {
    exchanged.user = { id: 'uid-stranger', email: 'stranger@evil.test' }

    const res = await GET(req())

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
    expect(deleted).toEqual(['uid-stranger'])
  })

  // An imported staff.csv row: real profile, real address, never invited.
  //
  // The auth user OAuth just minted must be deleted too. Leaving it alive
  // bricks that address permanently: the next `inviteMember` sees
  // `existing.authUserId === null`, proceeds to `inviteUserByEmail`, gets
  // `email_exists`, and fails — for good, until somebody deletes the stray
  // account by hand in the dashboard.
  it('refuses a profile that was never invited, and cleans up the minted account', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: { email: 'imported@c.test', name: 'Imported', role: 'STAFF', profession: 'NURSE' },
    })
    exchanged.user = { id: 'uid-new', email: 'imported@c.test' }

    const res = await GET(req())

    expect(errorOf(res)).toMatch(/roster/i)
    expect(signOut).toHaveBeenCalled()
    expect(deleted).toEqual(['uid-new'])
  })

  it('refuses a deactivated member', async () => {
    const db = await getTestDb()
    await db.user.create({
      data: {
        email: 'gone@c.test', name: 'Gone', role: 'STAFF', profession: 'NURSE',
        authUserId: 'uid-gone', deactivatedAt: new Date(),
      },
    })
    exchanged.user = { id: 'uid-gone', email: 'gone@c.test' }

    const res = await GET(req())

    expect(errorOf(res)).toMatch(/no longer active/i)
    expect(signOut).toHaveBeenCalled()
    // A deactivated member's account is banned, not deleted — deleting it would
    // discard the audit trail and let them be silently re-invited as new.
    expect(deleted).toEqual([])
  })

  it('redirects to login when the code exchange itself fails', async () => {
    exchanged.user = null
    exchanged.error = { message: 'invalid request: both auth code and code verifier should be non-empty' }

    const res = await GET(req())

    expect(res.headers.get('location')).toMatch(/\/login\?/)
    expect(deleted).toEqual([])
  })

  it('redirects to login when there is no code at all', async () => {
    const res = await GET(new Request('http://localhost/auth/callback'))
    expect(res.headers.get('location')).toMatch(/\/login\?/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/auth/callback.test.ts`
Expected: FAIL — cannot resolve `@/app/auth/callback/route`.

- [ ] **Step 3: Implement the callback**

Create `app/auth/callback/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db/client'
import { checkRosterByEmail } from '@/lib/auth/roster-gate'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

/**
 * Layer 3 of the roster gate (spec §5.4).
 *
 * Layer 1 is the dashboard's "allow new users to sign up" toggle, which gates
 * OAuth only. Layer 2 is `shouldCreateUser: false` on magic link, which gates
 * that path only — verified against GoTrue's source, `otp.go` never consults
 * DisableSignup at all. Neither knows anything about MedRoster's own roster, so
 * this layer is the one that asks the question that actually matters: is this
 * person a member?
 *
 * It also catches what the other two cannot — a member deactivated after their
 * account was created, and any auth user that exists without a profile.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')

  const deny = (reason: string) => {
    const target = new URL('/login', url.origin)
    target.searchParams.set('error', reason)
    return NextResponse.redirect(target)
  }

  if (!code) return deny('That sign-in link is not valid. Please try again.')

  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)
  if (error || !data.user?.email) {
    return deny('That sign-in link has expired. Please request a new one.')
  }

  const profile = await prisma.user.findUnique({
    where: { email: data.user.email.toLowerCase() },
    select: { deactivatedAt: true, authUserId: true },
  })

  const gate = checkRosterByEmail(profile)
  if (!gate.allowed) {
    await supabase.auth.signOut()

    // Delete the account OAuth just minted whenever the refusal was
    // "not a member" — both when there is no profile at all, and when there is
    // a profile that was never invited (an imported staff.csv row).
    //
    // The second case is the one that is easy to miss and expensive to get
    // wrong: leaving that auth user alive permanently bricks the address.
    // `inviteMember` checks `existing?.authUserId`, which is still null, so it
    // proceeds to `inviteUserByEmail`, receives `email_exists`, and fails — for
    // every future attempt, until somebody deletes the stray account by hand.
    //
    // A DEACTIVATED member is deliberately excluded: their account is banned
    // and audited, and deleting it would discard that record and let them be
    // silently re-invited as though new.
    if (!profile || !profile.authUserId) {
      await createSupabaseAdminClient().auth.admin.deleteUser(data.user.id)
    }

    return deny(gate.reason)
  }

  return NextResponse.redirect(new URL('/dashboard', url.origin))
}
```

- [ ] **Step 4: Add the passwordless buttons**

In `app/login/login-form.tsx`, below the existing password form, add:

- A **"Email me a sign-in link"** button that calls
  `createSupabaseBrowserClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: '<origin>/auth/callback' } })`
  and then renders "If that address is on the roster, a sign-in link is on its way." — the same non-committal wording as the forgot-password page, for the same enumeration reason.

  `shouldCreateUser: false` is **mandatory and load-bearing**: GoTrue's `otp.go` never checks the project's disable-signups setting, so this flag is the only thing standing between a stranger and an account on the magic-link path.

- A **"Continue with Google"** button calling
  `signInWithOAuth({ provider: 'google', options: { redirectTo: '<origin>/auth/callback' } })`.

Render `searchParams.error` from the callback's redirect in a `role="alert"` element above the form, so a rejected sign-in explains itself instead of silently bouncing.

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run tests/auth/ && npx tsc --noEmit && npm run lint`
Expected: PASS, type-clean, lint-clean.

- [ ] **Step 6: Commit**

```bash
git add app/auth/callback app/login/login-form.tsx tests/auth/callback.test.ts
git commit -m "feat(auth): gate magic link and Google sign-in on roster membership"
```

---

### Task 11: End-to-end verification and documentation

Proves the invite loop works against the real stack, and settles the one empirical question the spec left open.

**Files:**
- Create: `e2e/members.spec.ts`
- Modify: `README.md`, `docs/superpowers/specs/2026-07-30-supabase-auth-design.md`

- [ ] **Step 1: Confirm the §5.4.1 identity-linking behaviour**

Spec §5.4.1 reads GoTrue's source and concludes that a Google sign-in whose email matches an invited-but-unaccepted user resolves to `LinkAccount` — same user record, same uid — and that the unconfirmed email identity is removed. The source reading is solid; the *running* behaviour has still never been observed.

Two things are already settled and must NOT be re-litigated here — they were measured before this plan was written and are documented at the top of Task 7: emailed links deliver fragment tokens by default (hence `/auth/confirm`), and `additional_redirect_urls` is an exact-match allow-list including scheme.

What remains is the Google half. Invite an address through `/members`, do not accept the emailed link, then complete a Google sign-in for that same address and inspect what Supabase recorded:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -c "select u.id, u.email, u.email_confirmed_at, i.provider
      from auth.users u left join auth.identities i on i.user_id = u.id
      where u.email = '<the invited address>';"
```

Expected if §5.4.1 is right: **one** user row (not two), and the `email` identity gone, leaving only `google`.

Google OAuth needs real credentials in the Supabase dashboard. If they are not configured, **say so plainly in your report and leave §5.4.1 marked unverified** — do not mark it confirmed on the strength of the source reading. That distinction is the whole reason the spec words it the way it does.

- [ ] **Step 2: Write the end-to-end invite test**

Create `e2e/members.spec.ts`, following `e2e/import.spec.ts`'s conventions (read it first — it uses `login`, `assertClean`, `MANAGER_EMAIL`, `SEED_PASSWORD` from `./fixtures`).

The flagship test — invite a fresh address, read the link out of Mailpit, accept it, set a password, and sign in as that person:

```ts
import { test, expect, assertClean, login, SEED_PASSWORD, MANAGER_EMAIL } from './fixtures'

const MAILPIT = 'http://127.0.0.1:54324'

/** Newest message sent to `address`, via Mailpit's HTTP API. */
async function latestMessageTo(request: import('@playwright/test').APIRequestContext, address: string) {
  const list = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:' + address)}`)
  const body = await list.json()
  expect(body.messages?.length, `no invite email arrived for ${address}`).toBeGreaterThan(0)
  const full = await request.get(`${MAILPIT}/api/v1/message/${body.messages[0].ID}`)
  return await full.json()
}

test.describe('member invites', () => {
  test('a manager invites someone, who accepts the emailed link and signs in', async ({ page, request, capture }) => {
    // Unique per run: the address must not already exist in Supabase.
    const address = `invitee-${Date.now()}@clinicmail.test`

    await login(page, MANAGER_EMAIL, SEED_PASSWORD)
    await page.goto('/members')

    await page.getByLabel('Email').fill(address)
    await page.getByLabel('Name').fill('Invited Person')
    await page.getByRole('button', { name: 'Send invite' }).click()

    await expect(page.getByText(address)).toBeVisible()
    await expect(page.getByText('Invited')).toBeVisible()

    const message = await latestMessageTo(request, address)
    const link = (message.Text as string).match(/https?:\/\/\S+/)?.[0]
    expect(link, 'invite email contained no link').toBeTruthy()

    // A fresh context: the invitee is not the manager who invited them.
    const invitee = await page.context().browser()!.newContext()
    const inviteePage = await invitee.newPage()
    await inviteePage.goto(link!)

    await inviteePage.getByLabel('New password').fill('invitee-password-123')
    await inviteePage.getByLabel('Confirm password').fill('invitee-password-123')
    await inviteePage.getByRole('button', { name: /set password/i }).click()
    await inviteePage.waitForURL('/dashboard')

    await invitee.close()
    assertClean(capture)
  })

  test('a staff member cannot reach the members page', async ({ page, capture }) => {
    await login(page, 'ivy.bell@clinicmail.test', SEED_PASSWORD)
    const res = await page.goto('/members')
    expect(res!.status()).toBe(404)
    assertClean(capture)
  })
})
```

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS. Note `tests/concurrency/claim.test.ts` is documented as load-sensitive in `docs/KNOWN_ISSUES.md`; if only that fails, re-run it alone to confirm, and say so.

- [ ] **Step 4: Run the e2e suite against a production build**

Two terminals — `playwright.config.ts` omits `webServer` deliberately.

Terminal 1:
```bash
npm run build
npx next start -p 3100
```

Wait for `✓ Ready`, then terminal 2:
```bash
curl -sf -o /dev/null http://localhost:3100/login && echo "server up"
BASE_URL=http://localhost:3100 npm run test:e2e
```

Expected: all specs pass, including the new `members.spec.ts`.

- [ ] **Step 5: Update the documentation**

In `README.md`, add a "Members and invites" section covering: managers invite from `/members`; invitees receive an emailed link and set a password; locally those emails land in Mailpit at <http://127.0.0.1:54324>; and — stated plainly — that **invites will not reach real inboxes until custom SMTP is configured in the Supabase dashboard**, because the built-in mailer is capped near 2/hour and only delivers to project team addresses.

Also document that **"Allow new users to sign up" must be disabled** in the dashboard, and that this gates OAuth only — magic link is gated in code by `shouldCreateUser: false`.

In the spec, update §5.4.1's closing "Remaining empirical check" paragraph with what Step 1 actually observed, including anything that could not be verified.

- [ ] **Step 6: Commit**

```bash
git add e2e/members.spec.ts README.md docs/superpowers/specs/2026-07-30-supabase-auth-design.md
git commit -m "test(e2e): drive the invite loop end to end through Mailpit"
```

---

## Deferred from Plan 1, for a reviewer to triage

Recorded during the foundation work and still open. None blocks this plan:

- `isClientReachable` treats any `.tsx` as client-reachable, so a legitimate Server Component importing `admin.ts` would be flagged. Fails safe. **Task 6 is designed around this** rather than changing it.
- `applyMigrations`' `^`-anchored ADD/DROP COLUMN match ignores a statement whose first clause is not a column clause.
- `signOut()`'s returned `{ error }` is discarded in `app/login/actions.ts`.
- Stale comment in `tests/ui/app-shell.test.tsx:6-10` about Auth.js.
- `app_metadata` is written by the seed and by Task 3, and read by nothing. The spec's §2 "hint" role is unimplemented — deliberately, since the profile row is the authority. If it stays unread, consider dropping the writes rather than leaving a store nothing consumes.
