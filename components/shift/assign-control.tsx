'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Profession } from '@prisma/client'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { newMutationId } from '@/hooks/use-realtime'
import { useRegisterMutation } from '@/components/realtime/week-realtime-sync'
import { PROFESSION_LABELS } from '@/lib/domain/profession'

/**
 * Manager-only: assigns a named staff member to a shift (§8.3, "assign,
 * edit and delete" — the manager-only actions the shift detail page adds on
 * top of the claim/release every staff member gets). Posts the SAME
 * `POST /api/shifts/:id/claims` route a self-claim uses, just with an
 * explicit `userId` — `assignClaim` is the one function that creates a
 * Claim, so this can never enforce a different rule set than a self-claim.
 */
export function AssignControl({
  shiftId,
  profession,
  candidates,
}: {
  shiftId: number
  profession: Profession
  candidates: { id: number; name: string }[]
}) {
  const router = useRouter()
  const registerMutation = useRegisterMutation()
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function assign() {
    if (!selected) return
    setPending(true)
    setError(null)
    const mutationId = newMutationId()
    registerMutation(mutationId)

    const res = await fetch(`/api/shifts/${shiftId}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(selected), mutationId }),
    })
    setPending(false)

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setError(body?.error?.message ?? 'Something went wrong. Please try again.')
      return
    }
    setSelected(null)
    router.refresh()
  }

  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No other {PROFESSION_LABELS[profession].toLowerCase()}s available to assign.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <Select value={selected} onValueChange={(v) => setSelected(v as string | null)}>
        <SelectTrigger size="sm" aria-label={`Assign a ${PROFESSION_LABELS[profession].toLowerCase()}`}>
          <SelectValue placeholder="Assign staff…" />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" size="sm" variant="secondary" disabled={!selected || pending} onClick={() => void assign()}>
        Assign
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-rose-700 dark:text-rose-400">{error}</p>
      )}
    </div>
  )
}
