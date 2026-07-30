import { Badge } from '@/components/ui/badge'
import type { RuleDescriptor } from '@/lib/import/registry'

/**
 * "What these codes mean" — so a manager seeing `UNKNOWN_PROFESSION` on a
 * rejected row gets a sentence, not a bare token. `IMPORT_LEGEND` is already
 * assembled and conflict-checked at module load (`lib/import/legend.ts`);
 * this just renders it.
 */
export function ImportLegend({ legend }: { legend: RuleDescriptor[] }) {
  return (
    <div className="space-y-2 rounded-card border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">What these codes mean</h2>
      <dl className="divide-y divide-border">
        {legend.map((rule) => (
          <div key={rule.code} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-3">
            {/*
             * Code and badge stack rather than sit side by side: the longest codes
             * (UNPARSEABLE_REQUIREMENTS) already fill the column on their own, and a
             * shrink-0 nowrap Badge next to one would spill over the description.
             */}
            <dt className="flex min-w-0 flex-col items-start gap-1">
              <code className="max-w-full rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold break-words text-foreground">{rule.code}</code>
              <Badge variant={rule.severity === 'FATAL' ? 'destructive' : 'secondary'}>
                {rule.severity === 'FATAL' ? 'Rejects the row' : 'Repaired automatically'}
              </Badge>
            </dt>
            <dd className="text-sm text-muted-foreground">
              {rule.describe} <span className="text-xs">({rule.field})</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
