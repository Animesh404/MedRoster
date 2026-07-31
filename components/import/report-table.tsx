import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import type { ImportRowView } from '@/lib/contracts/imports'

const OUTCOME_STYLES: Record<ImportRowView['outcome'], { label: string; chip: string }> = {
  ACCEPTED: { label: 'Accepted', chip: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900' },
  REPAIRED: { label: 'Repaired', chip: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-900' },
  MERGED: { label: 'Merged', chip: 'bg-sky-50 text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-900' },
  REJECTED: { label: 'Rejected', chip: 'bg-rose-50 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900' },
}

/**
 * The Import Report's row table — a stated requirement (§4): for
 * every rejected or merged row, the raw source line, the outcome, and every
 * issue as `message` with `before → after` when the row was repaired rather
 * than just rejected outright.
 */
export function ReportTable({ rows }: { rows: ImportRowView[] }) {
  if (rows.length === 0) {
    return <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">No rows match this filter.</p>
  }

  return (
    <div className="rounded-card border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">Row</TableHead>
            <TableHead>Source line</TableHead>
            <TableHead className="w-28">Outcome</TableHead>
            <TableHead>Issues</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="align-top">
              <TableCell className="tabular text-muted-foreground">{row.rowNumber}</TableCell>
              <TableCell className="max-w-xs whitespace-pre-wrap break-all font-mono text-xs">{row.rawRow}</TableCell>
              <TableCell>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${OUTCOME_STYLES[row.outcome].chip}`}>
                  {OUTCOME_STYLES[row.outcome].label}
                </span>
              </TableCell>
              <TableCell className="whitespace-normal">
                {row.issues.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No issues.</span>
                ) : (
                  <ul className="space-y-1.5">
                    {row.issues.map((issue, i) => (
                      <li key={i} className="text-xs">
                        <code className="rounded bg-muted px-1 py-0.5 font-mono">{issue.code}</code>{' '}
                        <span className="text-foreground">{issue.message}</span>
                        {issue.before !== undefined && issue.after !== undefined && (
                          <span className="tabular ml-1 text-muted-foreground">
                            (<span className="text-rose-700 dark:text-rose-400">{issue.before}</span>
                            {' → '}
                            <span className="text-emerald-700 dark:text-emerald-400">{issue.after}</span>)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
