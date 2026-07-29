'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Profession } from '@prisma/client'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { newMutationId } from '@/hooks/use-realtime'
import { PROFESSION_LABELS } from '@/lib/domain/profession'

interface ShiftHolder {
  userId: number
  name: string
  profession: Profession | null
}

interface DeletePreview {
  version: number
  claimsToken: string
  holders: ShiftHolder[]
}

/**
 * Preview-then-confirm shift delete — the same two-step discipline as
 * `EditDialog`: a `DELETE ?dryRun=1` names everyone currently holding the
 * shift before anything is destroyed, and the confirm carries both
 * `expectedVersion` and `claimsToken` so a claim landing in the gap between
 * preview and confirm is caught, not silently overwritten.
 */
export function DeleteDialog({ shiftId }: { shiftId: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function runPreview() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/shifts/${shiftId}?dryRun=1`, { method: 'DELETE' })
    setBusy(false)
    const body = await res.json().catch(() => null) as (DeletePreview & { error?: never }) | { error: { message: string } } | null
    if (!res.ok || !body || 'error' in body) {
      setError((body && 'error' in body ? body.error.message : null) ?? 'Could not preview this delete. Please try again.')
      return
    }
    setPreview(body)
  }

  async function confirm() {
    if (!preview) return
    setBusy(true)
    setError(null)
    const mutationId = newMutationId()
    const params = new URLSearchParams({
      expectedVersion: String(preview.version), claimsToken: preview.claimsToken, mutationId,
    })
    const res = await fetch(`/api/shifts/${shiftId}?${params.toString()}`, { method: 'DELETE' })
    setBusy(false)

    if (res.ok) {
      router.push('/dashboard')
      router.refresh()
      return
    }

    const body = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null
    if (body?.error?.code === 'VERSION_CONFLICT') {
      setNotice('This shift changed while you were reviewing — the list below is up to date now. Check it and confirm again.')
      await runPreview()
      return
    }
    setError(body?.error?.message ?? 'Could not delete this shift. Please try again.')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void runPreview()
        else { setPreview(null); setNotice(null); setError(null) }
      }}
    >
      <DialogTrigger render={<Button type="button" variant="destructive" size="sm" />}>Delete shift</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this shift?</DialogTitle>
          <DialogDescription>This removes the shift and every claim on it. It cannot be undone.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {notice && (
            <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              {notice}
            </p>
          )}
          {busy && !preview ? (
            <p className="text-sm text-muted-foreground">Checking who holds this shift…</p>
          ) : preview && preview.holders.length > 0 ? (
            <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950">
              <p className="text-sm font-semibold text-rose-900 dark:text-rose-100">
                {preview.holders.length} {preview.holders.length === 1 ? 'person' : 'people'} currently hold this shift
              </p>
              <ul className="space-y-1 text-sm text-rose-800 dark:text-rose-200">
                {preview.holders.map((h) => (
                  <li key={h.userId}>
                    {h.name}{h.profession ? ` · ${PROFESSION_LABELS[h.profession]}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : preview ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              Nobody currently holds this shift.
            </p>
          ) : null}
          {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="destructive" disabled={busy || !preview} onClick={() => void confirm()}>
            {busy ? 'Working…' : 'Delete shift'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
