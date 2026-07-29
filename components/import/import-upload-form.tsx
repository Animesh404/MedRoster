'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/**
 * Manager CSV upload — a STAFF/SHIFT selector and a file input, posting the
 * same multipart shape `POST /api/imports` expects. Runs the exact engine
 * the seed used (`lib/import`), so there's no separate "upload parser" this
 * page could drift from.
 */
export function ImportUploadForm() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<'STAFF' | 'SHIFT'>('STAFF')
  const [fileName, setFileName] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      setError('Choose a CSV file first.')
      return
    }
    setSubmitting(true)
    setError(null)

    const form = new FormData()
    form.set('file', file)
    form.set('kind', kind)

    const res = await fetch('/api/imports', { method: 'POST', body: form })
    setSubmitting(false)

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message: string } } | null
      setError(body?.error?.message ?? 'Could not run this import. Please try again.')
      return
    }
    const body = await res.json() as { runId: number }
    router.push(`/import/${body.runId}`)
  }

  return (
    <div className="space-y-3 rounded-card border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Upload a CSV</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          What kind of file
          {/* `items` is what makes `Select.Value` render the label ("Staff
           *  roster") instead of the raw stored value ("STAFF") — see the
           *  same fix in `AssignControl` for the full explanation. */}
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as 'STAFF' | 'SHIFT')}
            items={{ STAFF: 'Staff roster', SHIFT: 'Shift schedule' }}
          >
            <SelectTrigger aria-label="File kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="STAFF">Staff roster</SelectItem>
              <SelectItem value="SHIFT">Shift schedule</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          CSV file
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            className="block text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
          />
        </label>

        <Button type="button" disabled={submitting} onClick={() => void submit()}>
          {submitting ? 'Running…' : 'Run import'}
        </Button>
      </div>
      {fileName && <p className="text-xs text-muted-foreground">Selected: {fileName}</p>}
      {error && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          {error}
        </p>
      )}
    </div>
  )
}
