import { NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { withAuth, errorResponse } from '@/lib/auth/with-auth'
import { createAppError } from '@/lib/domain/errors'
import { paginate } from '@/lib/db/paginate'
import { pageQuerySchema } from '@/lib/contracts/common'
import { findNulByteField, importKindSchema, normalizeFilename } from '@/lib/contracts/imports'
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
  // NOTE: this check runs after `req.formData()` above has already buffered
  // the entire multipart body into memory — the Fetch API has no way to
  // report a request's size before parsing completes, so there is no earlier
  // point in this handler to reject on size. That means this cap protects
  // the database and importer from an oversized *accepted* upload, not
  // server memory from an oversized *attempted* one: a several-hundred-MB
  // upload is fully buffered before this line ever runs. This is a framework
  // constraint, not a gap in this handler, and the route is manager-only
  // (`import:run`). The real mitigation belongs in front of Node — a
  // reverse-proxy or platform body-size limit (e.g. nginx
  // `client_max_body_size`, or the hosting platform's own request-size cap)
  // — so oversized bodies never reach this process at all in production.
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
  // content survives `file.text()` without throwing (the platform decoder is
  // lenient), and `file.name` is just as much attacker-controlled text as the
  // body — a filename of `evil\x00.csv` reaches `ImportRun.create` the same
  // way an unchecked NUL in the row text would reach
  // `ImportRowResult.createMany`. Without checking both, either one 500s
  // inside the transaction instead of failing cleanly before it starts.
  // See `findNulByteField` for why both fields are checked in one call.
  const nulField = findNulByteField({ filename: file.name, content: text })
  if (nulField) {
    return errorResponse(createAppError(
      'INVALID_INPUT',
      nulField === 'filename'
        ? 'The file name contains a NUL byte and cannot be processed.'
        : 'File contains binary data and cannot be processed as CSV.',
    ))
  }
  const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD ?? 'medroster123', 10)
  const meta = {
    source: 'UPLOAD' as const,
    filename: normalizeFilename(file.name),
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
