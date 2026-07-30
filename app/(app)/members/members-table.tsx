'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type MemberRole = 'MANAGER' | 'STAFF'
type MemberProfession = 'DOCTOR' | 'NURSE' | 'RECEPTIONIST'
type MemberStatus = 'active' | 'invited' | 'deactivated' | 'no-account'

export interface Member {
  id: number
  name: string
  email: string
  role: MemberRole
  profession: MemberProfession | null
  status: MemberStatus
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  deactivated: 'Deactivated',
  'no-account': 'No account',
}

const STATUS_VARIANT: Record<MemberStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  invited: 'secondary',
  deactivated: 'destructive',
  'no-account': 'outline',
}

const ROLE_ITEMS = { MANAGER: 'Manager', STAFF: 'Staff' } as const
const PROFESSION_ITEMS = { DOCTOR: 'Doctor', NURSE: 'Nurse', RECEPTIONIST: 'Receptionist' } as const

interface ErrorBody {
  error?: { message: string }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null
  return body?.error?.message ?? fallback
}

/**
 * `page.tsx` renders every row with an optimistic `status: 'active'` — it
 * can't derive the real status without the Supabase admin API, which must
 * never reach the client (see the module doc below). If this initial load
 * fails, the manager is looking at placeholder data with no way to tell, so
 * the message says so explicitly rather than reusing a generic failure text.
 */
const STALE_STATUS_MESSAGE = 'Could not load current member statuses. The list below may be out of date.'

/**
 * Manager-only roster table + invite form. Every mutation is a `fetch` to
 * `app/api/members/*` (Task 5) — this file never touches Prisma or Supabase
 * directly, which is what keeps `lib/supabase/admin.ts` out of the client
 * bundle (see `tests/auth/admin-containment.test.ts`).
 */
export function MembersTable({
  initialMembers,
  currentUserId,
}: {
  initialMembers: Member[]
  currentUserId: number
}) {
  const [members, setMembers] = useState<Member[]>(initialMembers)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<MemberRole>('STAFF')
  const [profession, setProfession] = useState<MemberProfession>('NURSE')
  const [error, setError] = useState<string | null>(null)
  // Keyed by 'form' for the invite form, or a member id for a per-row action,
  // so only the button(s) whose own request is in flight disable.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  // True only when the mount-time status fetch below has failed — every row
  // is still showing page.tsx's placeholder `status: 'active'`, so a
  // no-account or deactivated member reads as "Active" with a live
  // Deactivate button. Deactivating a no-account member sets deactivatedAt
  // on someone who never had an account, and there is no reactivation
  // feature in this branch — that misclick has no UI path back. Gates only
  // the per-row action buttons; the invite form above does not depend on
  // any row's status, so it stays usable.
  const [staleStatus, setStaleStatus] = useState(false)

  /** Re-fetches the roster and replaces `members` wholesale. A failure here
   *  (a bad status, or the request itself rejecting) is surfaced the same
   *  way a mutation failure is: a successful mutation followed by a failed
   *  refresh must not leave the manager looking at stale rows with no
   *  indication anything went wrong. */
  async function refreshMembers() {
    try {
      const res = await fetch('/api/members')
      if (!res.ok) {
        setError(await readErrorMessage(res, 'Could not refresh the member list. It may be out of date.'))
        return
      }
      const body = (await res.json().catch(() => null)) as { members?: Member[] } | null
      if (body?.members) setMembers(body.members)
    } catch {
      setError('Could not reach the server to refresh the member list. It may be out of date.')
    }
  }

  // page.tsx can only render an optimistic 'active' placeholder for every
  // row — deriving the real status needs the Supabase admin API, which must
  // stay out of this client bundle (tests/auth/admin-containment.test.ts).
  // Without this, the Invite/Resend/Revoke controls — gated on status — stay
  // invisible until some unrelated mutation happens to trigger a refresh.
  useEffect(() => {
    // Guards against setting state after this component has unmounted (e.g.
    // the test that renders it resolves after the test itself has moved on).
    let ignore = false

    async function loadInitialStatuses() {
      try {
        const res = await fetch('/api/members')
        if (ignore) return
        if (!res.ok) {
          setError(STALE_STATUS_MESSAGE)
          setStaleStatus(true)
          return
        }
        const body = (await res.json().catch(() => null)) as { members?: Member[] } | null
        if (ignore) return
        if (body?.members) setMembers(body.members)
      } catch {
        if (!ignore) {
          setError(STALE_STATUS_MESSAGE)
          setStaleStatus(true)
        }
      }
    }

    void loadInitialStatuses()
    return () => {
      ignore = true
    }
  }, [])

  /** Runs one mutation: marks `key` busy, clears/sets the shared error, and
   *  re-fetches the roster on success. Returns whether it succeeded, so
   *  callers can reset form state only when the server actually accepted it.
   *  `request()` itself can reject outright (offline, DNS failure, connection
   *  reset) rather than resolving with a bad status — every caller invokes
   *  this as a fire-and-forget `void runMutation(...)`, so without this catch
   *  that rejection would escape as an unhandled promise rejection with no
   *  alert shown. */
  async function runMutation(key: string, request: () => Promise<Response>, fallback: string): Promise<boolean> {
    setBusy((b) => ({ ...b, [key]: true }))
    setError(null)
    try {
      const res = await request()
      if (!res.ok) {
        setError(await readErrorMessage(res, fallback))
        return false
      }
      await refreshMembers()
      return true
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      return false
    } finally {
      setBusy((b) => ({ ...b, [key]: false }))
    }
  }

  async function submitInvite(e: FormEvent) {
    e.preventDefault()
    const ok = await runMutation(
      'form',
      () =>
        fetch('/api/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, role, profession: role === 'STAFF' ? profession : null }),
        }),
      'Could not send that invite. Please try again.',
    )
    if (ok) {
      setEmail('')
      setName('')
      setRole('STAFF')
      setProfession('NURSE')
    }
  }

  function invite(member: Member) {
    void runMutation(
      String(member.id),
      () =>
        fetch('/api/members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: member.email,
            name: member.name,
            role: member.role,
            profession: member.profession,
          }),
        }),
      'Could not send that invite. Please try again.',
    )
  }

  function resend(member: Member) {
    void runMutation(
      String(member.id),
      () => fetch(`/api/members/${member.id}/invite`, { method: 'POST' }),
      'Could not resend that invite. Please try again.',
    )
  }

  function revoke(member: Member) {
    void runMutation(
      String(member.id),
      () => fetch(`/api/members/${member.id}/invite`, { method: 'DELETE' }),
      'Could not revoke that invite. Please try again.',
    )
  }

  function deactivate(member: Member) {
    void runMutation(
      String(member.id),
      () => fetch(`/api/members/${member.id}`, { method: 'DELETE' }),
      'Could not deactivate that member. Please try again.',
    )
  }

  const formBusy = busy.form ?? false

  return (
    <div className="space-y-6">
      <form
        className="space-y-3 rounded-card border border-border bg-card p-4"
        onSubmit={(e) => void submitInvite(e)}
      >
        <h2 className="text-sm font-semibold text-foreground">Invite a member</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Email
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-56"
            />
          </label>

          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} required className="w-48" />
          </label>

          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Role
            <Select
              value={role}
              onValueChange={(v) => {
                const nextRole = v as MemberRole
                setRole(nextRole)
                // MANAGER must carry no profession — inviteMemberSchema
                // forbids one, so pick a valid STAFF default the moment
                // someone switches back rather than leaving a stale value.
                if (nextRole === 'STAFF') setProfession('NURSE')
              }}
              items={ROLE_ITEMS}
            >
              <SelectTrigger aria-label="Role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MANAGER">Manager</SelectItem>
                <SelectItem value="STAFF">Staff</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Profession
            <Select
              value={profession}
              onValueChange={(v) => setProfession(v as MemberProfession)}
              items={PROFESSION_ITEMS}
              disabled={role === 'MANAGER'}
            >
              <SelectTrigger aria-label="Profession"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DOCTOR">Doctor</SelectItem>
                <SelectItem value="NURSE">Nurse</SelectItem>
                <SelectItem value="RECEPTIONIST">Receptionist</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <Button type="submit" disabled={formBusy}>
            {formBusy ? 'Sending…' : 'Send invite'}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Profession</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const rowBusy = busy[String(member.id)] ?? false
            const isSelf = member.id === currentUserId
            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium text-foreground">{member.name}</TableCell>
                <TableCell className="text-muted-foreground">{member.email}</TableCell>
                <TableCell>{ROLE_ITEMS[member.role]}</TableCell>
                <TableCell>{member.profession ? PROFESSION_ITEMS[member.profession] : '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[member.status]}>{STATUS_LABEL[member.status]}</Badge>
                </TableCell>
                <TableCell className="space-x-2">
                  {member.status === 'no-account' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rowBusy || staleStatus}
                      onClick={() => invite(member)}
                    >
                      Invite
                    </Button>
                  )}
                  {member.status === 'invited' && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={rowBusy || staleStatus}
                        onClick={() => resend(member)}
                      >
                        Resend
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={rowBusy || staleStatus}
                        onClick={() => revoke(member)}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                  {(member.status === 'active' || member.status === 'invited') && !isSelf && (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={rowBusy || staleStatus}
                      onClick={() => deactivate(member)}
                    >
                      Deactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
