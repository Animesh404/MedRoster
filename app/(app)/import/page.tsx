import { notFound } from 'next/navigation'
import { auth } from '@/auth'
import { PageHero } from '@/components/page-hero'
import { PaginationLinks } from '@/components/pagination-links'
import { ImportUploadForm } from '@/components/import/import-upload-form'
import { ImportLegend } from '@/components/import/import-legend'
import { RunHistoryTable, type ImportRunRow } from '@/components/import/run-history-table'
import { IMPORT_LEGEND } from '@/lib/import/legend'
import { can, type Principal } from '@/lib/auth/permissions'
import { internalFetch } from '@/lib/server/internal-fetch'

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const session = await auth()
  if (!session?.user) notFound() // middleware already guards this route
  const principal: Principal = { id: session.user.id, role: session.user.role, profession: session.user.profession }
  // Defence in depth: `import:read`/`import:run` are manager-only permissions
  // (STAFF_PERMISSIONS has neither) — the nav already hides this link from
  // staff, but a typed URL must not reach it either.
  if (!can(principal, 'import:read')) notFound()

  const { cursor } = await searchParams
  const qs = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })
  const res = await internalFetch(`/api/imports?${qs.toString()}`)
  const page = res.ok
    ? (await res.json()) as { items: ImportRunRow[]; nextCursor: string | null }
    : { items: [], nextCursor: null }

  return (
    <div className="space-y-8">
      <PageHero eyebrow="Data" title="Import">
        <p className="max-w-prose text-white/85">
          Upload a staff roster or shift schedule CSV. The same cleaning rules that built the
          seeded roster run here — nothing about an upload is treated any differently.
        </p>
      </PageHero>

      <ImportUploadForm />

      <ImportLegend legend={IMPORT_LEGEND} />

      <section aria-labelledby="run-history-heading" className="space-y-3">
        <h2 id="run-history-heading" className="text-lg font-semibold text-foreground">Run history</h2>
        <RunHistoryTable runs={page.items} />
        <PaginationLinks
          basePath="/import"
          searchParams={{ cursor }}
          nextCursor={page.nextCursor}
          onFirstPage={!cursor}
        />
      </section>
    </div>
  )
}
