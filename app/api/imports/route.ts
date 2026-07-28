import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { importKindSchema } from '@/lib/contracts/imports'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { TX_OPTIONS } from '@/lib/rules/assign'

const MAX_BYTES = 2 * 1024 * 1024

export const GET = withAuth('import:read', async (req) => {
  const url = new URL(req.url)
  // .safeParse, not .parse (IMP-3): see app/api/shifts/route.ts for the
  // full rationale — an ordinary bad `?limit=` must 400, not 500.
  const parsedQuery = pageQuerySchema.safeParse({
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsedQuery.success) {
    return errorResponse(createAppError('INVALID_INPUT', parsedQuery.error.issues[0]!.message))
  }
  const { cursor, limit } = parsedQuery.data

  const page = await paginate({
    limit, cursor,
    findMany: (args) => prisma.importRun.findMany({
      ...args,
      select: {
        id: true, source: true, fileKind: true, filename: true,
        stats: true, createdAt: true,
        actor: { select: { name: true } },
      },
    }),
  })

  return NextResponse.json(page)
})

/**
 * Manager CSV upload. Runs the exact same engine as the seed (§5, §7.2) —
 * there is no separate "upload parser" that could drift from the seeded rules.
 */
export const POST = withAuth('import:run', async (req, ctx) => {
  const form = await req.formData().catch(() => null)
  if (!form) return errorResponse(createAppError('INVALID_INPUT', 'Expected a multipart upload.'))

  const file = form.get('file')
  const kindRaw = form.get('kind')

  if (!(file instanceof File)) {
    return errorResponse(createAppError('INVALID_INPUT', 'No file was uploaded.'))
  }
  if (file.size === 0) {
    return errorResponse(createAppError('INVALID_INPUT', 'The uploaded file is empty.'))
  }
  if (file.size > MAX_BYTES) {
    return errorResponse(createAppError('INVALID_INPUT', 'File is larger than 2 MB.'))
  }

  const kind = importKindSchema.safeParse(kindRaw)
  if (!kind.success) {
    return errorResponse(createAppError('INVALID_INPUT', 'kind must be STAFF or SHIFT.'))
  }

  const text = await file.text()
  // Postgres `text` columns cannot store a NUL byte at all (error 22021) —
  // not a validation preference, a hard encoding limit. Binary/garbage
  // uploads survive `file.text()` without throwing (the platform decoder is
  // lenient), so without this check a NUL byte anywhere in the row text
  // only surfaces once `ImportRowResult.createMany` hits the database,
  // where it becomes an uncaught 500 instead of a clean rejection.
  if (text.includes('\0')) {
    return errorResponse(createAppError('INVALID_INPUT', 'File contains binary data and cannot be processed as CSV.'))
  }
  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD ?? 'medroster123', 10)
  const meta = {
    source: 'UPLOAD' as const,
    filename: file.name,
    actorId: ctx.principal.id,
    passwordHash,
  }

  // READ COMMITTED (TX_OPTIONS) plus a raised timeout: a shift upload can
  // write on the order of 100+ shifts and 300+ requirement rows, which
  // Prisma's 5s default would spuriously roll back mid-import. Wrapping
  // both kinds in one transaction means a failure partway through can never
  // leave a half-imported roster.
  const { runId, stats } = await prisma.$transaction(async (tx) => {
    if (kind.data === 'STAFF') {
      const result = runStaffImport(text)
      return { runId: await applyStaffImport(tx, result, meta), stats: result.stats }
    }
    const result = runShiftImport(text)
    return { runId: await applyShiftImport(tx, result, meta), stats: result.stats }
  }, { ...TX_OPTIONS, timeout: 30_000 })

  return NextResponse.json({ runId, stats }, { status: 201 })
})
