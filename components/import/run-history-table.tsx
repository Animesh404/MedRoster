import Link from 'next/link'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export interface ImportRunRow {
  id: number
  source: 'SEED' | 'UPLOAD'
  fileKind: 'STAFF' | 'SHIFT'
  filename: string
  stats: { accepted: number; merged: number; rejected: number; total: number }
  createdAt: string
  actor: { name: string } | null
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
})

/** Run history — every SEED and UPLOAD run, linking each to its report. */
export function RunHistoryTable({ runs }: { runs: ImportRunRow[] }) {
  if (runs.length === 0) {
    return <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">No imports have run yet.</p>
  }

  return (
    <div className="rounded-card border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>File</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell>
                <Link href={`/import/${run.id}`} className="font-medium text-brand-deep underline-offset-2 hover:underline dark:text-brand-mid">
                  #{run.id} · {run.source === 'SEED' ? 'Seed' : 'Upload'}
                </Link>
                <p className="text-xs text-muted-foreground">{run.fileKind === 'STAFF' ? 'Staff roster' : 'Shift schedule'}</p>
              </TableCell>
              <TableCell className="max-w-40 truncate font-mono text-xs" title={run.filename}>{run.filename}</TableCell>
              <TableCell className="tabular text-xs">
                {run.stats.accepted} accepted · {run.stats.merged} merged · {run.stats.rejected} rejected of {run.stats.total}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {dateFmt.format(new Date(run.createdAt))}{run.actor ? ` · ${run.actor.name}` : ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
