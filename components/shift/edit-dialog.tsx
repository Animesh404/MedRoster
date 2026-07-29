'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Profession } from '@prisma/client'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { RequirementStepper } from '@/components/shift/requirement-stepper'
import { newMutationId } from '@/hooks/use-realtime'
import { useRegisterMutation } from '@/components/realtime/week-realtime-sync'
import { PROFESSIONS } from '@/lib/domain/profession'

interface DroppedClaim {
  userId: number
  name: string
  profession: Profession | null
  reason: string
}

interface EditPreview {
  version: number
  claimsToken: string
  kept: number[]
  dropped: DroppedClaim[]
}

const CLINIC_TZ = 'Europe/London' // client bundles only NEXT_PUBLIC_* env vars; server is authoritative (see WeekPicker)
const clinicDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const clinicTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: CLINIC_TZ, hour: '2-digit', minute: '2-digit', hour12: false })

function initialFields(startsAt: string, endsAt: string, requirements: Record<Profession, number>) {
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  return {
    date: clinicDateFmt.format(start),
    startTime: clinicTimeFmt.format(start),
    endTime: clinicTimeFmt.format(end),
    requirements: { ...requirements },
  }
}

/**
 * Preview-then-confirm shift edit (§ edit and delete flows). A `PATCH
 * ?dryRun=1` re-runs the SAME validator every claim was originally checked
 * against, against the proposed new shift — so "who gets dropped" is never a
 * client-side guess. Confirming carries both `expectedVersion` AND
 * `claimsToken`: version alone can't detect a claim landing between preview
 * and confirm, because claiming never bumps `Shift.version`
 * (`lib/rules/edit.ts`'s `EditPreview` doc comment).
 */
export function EditDialog({
  shiftId,
  startsAt,
  endsAt,
  requirements,
}: {
  shiftId: number
  startsAt: string
  endsAt: string
  requirements: Record<Profession, number>
}) {
  const router = useRouter()
  const registerMutation = useRegisterMutation()
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState(() => initialFields(startsAt, endsAt, requirements))
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [preview, setPreview] = useState<EditPreview | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setFields(initialFields(startsAt, endsAt, requirements))
    setStep('form')
    setPreview(null)
    setNotice(null)
    setError(null)
  }

  async function runPreview() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/shifts/${shiftId}?dryRun=1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: fields.date, startTime: fields.startTime, endTime: fields.endTime,
        requirements: fields.requirements, mutationId: newMutationId(),
      }),
    })
    setBusy(false)
    const body = await res.json().catch(() => null) as (EditPreview & { error?: never }) | { error: { message: string } } | null
    if (!res.ok || !body || 'error' in body) {
      setError((body && 'error' in body ? body.error.message : null) ?? 'Could not preview this change. Please try again.')
      return
    }
    setPreview(body)
    setStep('preview')
  }

  async function confirm() {
    if (!preview) return
    setBusy(true)
    setError(null)
    const mutationId = newMutationId()
    registerMutation(mutationId)

    const res = await fetch(`/api/shifts/${shiftId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: fields.date, startTime: fields.startTime, endTime: fields.endTime,
        requirements: fields.requirements,
        expectedVersion: preview.version, claimsToken: preview.claimsToken,
        mutationId,
      }),
    })
    setBusy(false)

    if (res.ok) {
      setOpen(false)
      reset()
      router.refresh()
      return
    }

    const body = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null
    if (body?.error?.code === 'VERSION_CONFLICT') {
      // Re-run the preview and say so, rather than silently retrying the
      // confirm against a plan that's no longer accurate.
      setNotice('This shift changed while you were reviewing — the preview below is up to date now. Check it and confirm again.')
      await runPreview()
      return
    }
    setError(body?.error?.message ?? 'Could not save this change. Please try again.')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset() }}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Edit shift</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit shift</DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? 'Change the time or headcount, then preview who this affects before saving.'
              : 'Review before confirming — this is exactly who will keep and lose the shift.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Date
                <Input type="date" value={fields.date} onChange={(e) => setFields((f) => ({ ...f, date: e.target.value }))} />
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Starts
                <Input type="time" value={fields.startTime} onChange={(e) => setFields((f) => ({ ...f, startTime: e.target.value }))} />
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Ends
                <Input type="time" value={fields.endTime} onChange={(e) => setFields((f) => ({ ...f, endTime: e.target.value }))} />
              </label>
            </div>
            <div className="space-y-2">
              {PROFESSIONS.map((profession) => (
                <RequirementStepper
                  key={profession}
                  profession={profession}
                  value={fields.requirements[profession]}
                  onChange={(next) => setFields((f) => ({ ...f, requirements: { ...f.requirements, [profession]: next } }))}
                />
              ))}
            </div>
            {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {notice && (
              <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                {notice}
              </p>
            )}
            {preview && preview.dropped.length > 0 ? (
              <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950">
                <p className="text-sm font-semibold text-rose-900 dark:text-rose-100">
                  {preview.dropped.length} {preview.dropped.length === 1 ? 'person' : 'people'} will lose this shift
                </p>
                <ul className="space-y-1.5">
                  {preview.dropped.map((d) => (
                    <li key={d.userId} className="text-sm text-rose-800 dark:text-rose-200">
                      <span className="font-medium">{d.name}</span> — {d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Nobody currently holding this shift will be affected.
              </p>
            )}
            {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
            <Button type="button" disabled={busy} onClick={() => void runPreview()}>
              {busy ? 'Checking…' : 'Preview changes'}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setStep('form')}>
                Back
              </Button>
              <Button type="button" disabled={busy} onClick={() => void confirm()}>
                {busy ? 'Saving…' : 'Confirm changes'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
