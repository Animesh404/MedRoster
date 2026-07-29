import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { PageHero } from '@/components/page-hero'
import { PaginationLinks } from '@/components/pagination-links'
import { OutcomeBar } from '@/components/import/outcome-bar'
import { OutcomeFilter } from '@/components/import/outcome-filter'
import { ReportTable } from '@/components/import/report-table'
import { ImportLegend } from '@/components/import/import-legend'
import { IMPORT_LEGEND } from '@/lib/import/legend'
import { can, type Principal } from '@/lib/auth/permissions'
import { exactOutcomeCountsSchema, importRowSchema } from '@/lib/contracts/imports'
import { internalFetch } from '@/lib/server/internal-fetch'

interface RunSummary {
  id: number
  source: 'SEED' | 'UPLOAD'
  fileKind: 'STAFF' | 'SHIFT'
  filename: string
  createdAt: string
  actor: { name: string } | null
}

const OUTCOMES = ['ACCEPTED', 'REPAIRED', 'MERGED', 'REJECTED'] as const

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  timeZone: process.env.CLINIC_TZ ?? 'Europe/London',
})

export default async function ImportReportPage({
  params, searchParams,
}: {
  params: Promise<{ runId: string }>
  searchParams: Promise<{ outcome?: string; cursor?: string }>
}) {
  const session = await auth()
  if (!session?.user) notFound() // middleware already guards this route
  const principal: Principal = { id: session.user.id, role: session.user.role, profession: session.user.profession }
  // Defence in depth — see app/(app)/import/page.tsx: `import:read` is
  // manager-only, and a typed URL must not reach a report staff can't list.
  if (!can(principal, 'import:read')) notFound()

  const { runId: runIdRaw } = await params
  const runId = Number(runIdRaw)
  if (!Number.isInteger(runId) || runId < 1) notFound()

  const { outcome, cursor } = await searchParams
  const activeOutcome = outcome && (OUTCOMES as readonly string[]).includes(outcome) ? outcome : null

  const qs = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}), ...(activeOutcome ? { outcome: activeOutcome } : {}) })
  const pageRes = await internalFetch(`/api/imports/${runId}?${qs.toString()}`)
  if (pageRes.status === 404) notFound()
  if (!pageRes.ok) throw new Error(`Failed to load import run ${runId} (${pageRes.status})`)

  const body = await pageRes.json() as { run: RunSummary; outcomeCounts: unknown; items: unknown[]; nextCursor: string | null }
  const rows = body.items.map((r) => importRowSchema.parse(r))
  // Whole-run counts (§lib/import/report.ts) — always unfiltered by
  // `activeOutcome`, so the outcome bar and "% kept" gauge below describe
  // the entire run even while the row table itself is filtered down to one
  // outcome.
  const counts = exactOutcomeCountsSchema.parse(body.outcomeCounts)

  const kept = counts.total - counts.rejected
  const gaugeValue = counts.total > 0 ? kept / counts.total : 1

  const outcomeCountsForFilter = {
    ACCEPTED: counts.accepted, REPAIRED: counts.repaired, MERGED: counts.merged, REJECTED: counts.rejected,
  }

  return (
    <div className="space-y-8">
      <PageHero
        eyebrow={`Import #${body.run.id} · ${body.run.source === 'SEED' ? 'Seed' : 'Upload'}`}
        title={body.run.filename}
        gauge={{ value: gaugeValue, label: `${Math.round(gaugeValue * 100)}% of rows kept` }}
      >
        <p className="text-white/90">
          {body.run.fileKind === 'STAFF' ? 'Staff roster' : 'Shift schedule'} · {dateFmt.format(new Date(body.run.createdAt))}
          {body.run.actor ? ` · run by ${body.run.actor.name}` : ''}
        </p>
      </PageHero>

      <section aria-labelledby="outcome-heading" className="space-y-3">
        <h2 id="outcome-heading" className="text-lg font-semibold text-foreground">Outcome</h2>
        <OutcomeBar counts={counts} />
      </section>

      <section aria-labelledby="rows-heading" className="space-y-3">
        <h2 id="rows-heading" className="text-lg font-semibold text-foreground">Rows</h2>
        <OutcomeFilter runId={runId} active={activeOutcome} counts={outcomeCountsForFilter} />
        <ReportTable rows={rows} />
        <PaginationLinks
          basePath={`/import/${runId}`}
          searchParams={{ outcome: activeOutcome ?? undefined, cursor }}
          nextCursor={body.nextCursor}
          onFirstPage={!cursor}
        />
      </section>

      <ImportLegend legend={IMPORT_LEGEND} />
    </div>
  )
}
