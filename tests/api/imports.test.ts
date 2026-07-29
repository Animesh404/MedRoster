import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRowResult } from '@prisma/client'
import { runStaffImport } from '@/lib/import'
import { applyStaffImport } from '@/lib/import/apply'
import { paginate, type Page } from '@/lib/db/paginate'
import { importRowSchema, importStatsSchema } from '@/lib/contracts/imports'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

// Route handlers call `prisma` imported from '@/lib/db/client', which in
// production wires a real driver adapter off `process.env.DATABASE_URL`.
// Tests redirect that import to the same Testcontainers instance the rest
// of the suite uses, so the routes are exercised against a real Postgres
// without needing a live DATABASE_URL in the test environment.
vi.mock('@/lib/db/client', async () => {
  const { getTestDb: get } = await import('../helpers/db')
  return { prisma: await get() }
})

let session: { user: { id: number; email: string; name: string; role: 'STAFF' | 'MANAGER'; profession: string | null } } | null = null
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(session) }))

const { GET: importsGet, POST: importsPost } = await import('@/app/api/imports/route')
const { GET: importGet } = await import('@/app/api/imports/[runId]/route')

const noParams = { params: Promise.resolve({}) }

async function asManager() {
  const db = await getTestDb()
  const manager = await db.user.create({
    data: { email: 'mgr@c.test', name: 'Manager', passwordHash: 'x', role: 'MANAGER', profession: null },
  })
  session = { user: { id: manager.id, email: manager.email, name: manager.name, role: 'MANAGER', profession: null } }
  return manager
}

async function asStaff() {
  const db = await getTestDb()
  const staff = await db.user.create({
    data: { email: 'staff@c.test', name: 'Staff', passwordHash: 'x', role: 'STAFF', profession: 'NURSE' },
  })
  session = { user: { id: staff.id, email: staff.email, name: staff.name, role: 'STAFF', profession: 'NURSE' } }
  return staff
}

function uploadReq(url: string, form: FormData) {
  return new Request(url, { method: 'POST', body: form })
}

beforeEach(() => { session = null })
beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('import report data', () => {
  it('pages through all 41 report rows without repeats', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const seen: number[] = []
    let cursor: string | null = null
    do {
      const page: Page<ImportRowResult> = await paginate({
        limit: 10, cursor,
        findMany: (args) => db.importRowResult.findMany({ ...args, where: { importRunId: runId } }),
      })
      seen.push(...page.items.map((r) => r.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(41)
    expect(new Set(seen).size).toBe(41)
  })

  it('can filter the report down to just the rejections', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const rejected = await db.importRowResult.findMany({
      where: { importRunId: runId, outcome: 'REJECTED' },
    })
    expect(rejected).toHaveLength(4)
    expect(rejected.map((r) => Number(r.rawRow.split(',')[0])).sort())
      .toEqual([995, 996, 997, 998])
  })

  it('stores the stats the run reported', async () => {
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const run = await db.importRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.stats).toEqual({ accepted: 34, merged: 3, rejected: 4, total: 41 })
  })
})

describe('POST /api/imports', () => {
  it('accepts a staff CSV upload and returns runId + stats', async () => {
    await asManager()
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File([readFileSync('staff.csv', 'utf8')], 'staff.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(201)
    const body = await res.json() as { runId: number; stats: { accepted: number; merged: number; rejected: number; total: number } }
    expect(body.stats).toEqual({ accepted: 34, merged: 3, rejected: 4, total: 41 })
    // MINOR-1: the contract is declared but never enforced anywhere unless a
    // test actually parses a real response against it.
    importStatsSchema.parse(body.stats)

    const db = await getTestDb()
    const users = await db.user.count({ where: { role: 'STAFF' } })
    expect(users).toBe(34)
  })

  it('rejects a staff member without permission with 403', async () => {
    await asStaff()
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File(['staff_id,full_name,role,email'], 'staff.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(403)
  })

  it('rejects a request with no file field with 400, not a crash', async () => {
    await asManager()
    const form = new FormData()
    form.set('kind', 'STAFF')

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('rejects a non-File file field with 400, not a crash', async () => {
    await asManager()
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', 'not-a-file')

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('rejects an unrecognised kind with 400', async () => {
    await asManager()
    const form = new FormData()
    form.set('kind', 'NOPE')
    form.set('file', new File(['a,b,c,d'], 'x.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('rejects a file larger than 2 MB with 400', async () => {
    await asManager()
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File([big], 'big.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('rejects an empty file with 400, not a crash', async () => {
    await asManager()
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File([''], 'empty.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('cleanly rejects content with NUL bytes instead of 500ing on the DB write', async () => {
    await asManager()
    // Postgres `text` columns cannot store 0x00 at all (error 22021). This
    // must come back as a clean 400 from the transport layer rather than an
    // uncaught 500 once ImportRowResult.createMany hits the database.
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 10, 0, 1, 2])
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File([bytes], 'garbage.bin', { type: 'application/octet-stream' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })

  it('cleanly rejects a NUL byte in the *filename* instead of 500ing on ImportRun.create (CRIT-1)', async () => {
    await asManager()
    const db = await getTestDb()
    // Content is clean valid CSV — only the filename carries the NUL byte.
    // Without a guard, this reaches `ImportRun.create({ data: { filename } })`
    // inside the transaction and Postgres rejects it with 22021 ("invalid
    // byte sequence for encoding UTF8: 0x00"), which withAuth's boundary
    // turns into a bare 500 instead of a clean 400.
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File(['staff_id,full_name,role,email'], 'evil\0.csv', { type: 'text/csv' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')

    // The transaction must never have started — no partial ImportRun row.
    expect(await db.importRun.count()).toBe(0)
  })

  it('cleanly rejects garbage bytes without NULs as an all-rejected report, not a crash', async () => {
    await asManager()
    // No NUL bytes here, so this exercises the "let the importer's own row
    // rejection do the work" path instead of the transport-layer NUL guard.
    const bytes = new Uint8Array([255, 254, 253, 252, 10, 251, 250, 249])
    const form = new FormData()
    form.set('kind', 'STAFF')
    form.set('file', new File([bytes], 'garbage.bin', { type: 'application/octet-stream' }))

    const res = await importsPost(uploadReq('http://localhost/api/imports', form), noParams)
    expect(res.status).toBe(201)
    const body = await res.json() as { stats: { accepted: number; total: number } }
    expect(body.stats.accepted).toBe(0)
  })

  it('a non-multipart body is rejected with 400, not a crash', async () => {
    await asManager()
    const res = await importsPost(
      new Request('http://localhost/api/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'STAFF' }),
      }),
      noParams,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')
  })
})

describe('GET /api/imports', () => {
  it('lists runs newest activity first, paginated', async () => {
    await asManager()
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const res = await importsGet(new Request('http://localhost/api/imports'), noParams)
    expect(res.status).toBe(200)
    const body = await res.json() as { items: { id: number; filename: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.filename).toBe('staff.csv')
  })
})

describe('GET /api/imports/:runId', () => {
  it('returns the run plus a paginated, filterable row report', async () => {
    await asManager()
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    const res = await importGet(
      new Request(`http://localhost/api/imports/${runId}?limit=50`),
      { params: Promise.resolve({ runId: String(runId) }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { run: { id: number }; items: unknown[] }
    expect(body.run.id).toBe(runId)
    expect(body.items).toHaveLength(41)
    // MINOR-1: enforce importRowSchema against a real response instead of
    // leaving it an aspirational, never-parsed contract.
    body.items.forEach((item) => importRowSchema.parse(item))

    const rejectedOnly = await importGet(
      new Request(`http://localhost/api/imports/${runId}?limit=50&outcome=REJECTED`),
      { params: Promise.resolve({ runId: String(runId) }) },
    )
    const rejectedBody = await rejectedOnly.json() as { items: unknown[] }
    expect(rejectedBody.items).toHaveLength(4)
  })

  it('includes exact whole-run outcomeCounts, unaffected by the page limit or an outcome filter', async () => {
    await asManager()
    const db = await getTestDb()
    const result = runStaffImport(readFileSync('staff.csv', 'utf8'))
    const runId = await db.$transaction((tx) =>
      applyStaffImport(tx, result, { source: 'UPLOAD', filename: 'staff.csv', passwordHash: 'x' }))

    // A tiny page size (limit=5) must not shrink outcomeCounts along with
    // the row page it accompanies — see lib/import/report.ts.
    const res = await importGet(
      new Request(`http://localhost/api/imports/${runId}?limit=5`),
      { params: Promise.resolve({ runId: String(runId) }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { outcomeCounts: { accepted: number; repaired: number; merged: number; rejected: number; total: number }; items: unknown[] }
    expect(body.items).toHaveLength(5) // the page itself IS limited...
    expect(body.outcomeCounts).toEqual({ accepted: 5, repaired: 29, merged: 3, rejected: 4, total: 41 }) // ...outcomeCounts is not

    // Filtering the row page down to just REJECTED must not filter
    // outcomeCounts down too — it always describes the whole run.
    const filtered = await importGet(
      new Request(`http://localhost/api/imports/${runId}?limit=5&outcome=REJECTED`),
      { params: Promise.resolve({ runId: String(runId) }) },
    )
    const filteredBody = await filtered.json() as { outcomeCounts: unknown }
    expect(filteredBody.outcomeCounts).toEqual(body.outcomeCounts)
  })

  it('returns 400 for a non-numeric run id rather than a 500', async () => {
    await asManager()
    const res = await importGet(
      new Request('http://localhost/api/imports/not-a-number'),
      { params: Promise.resolve({ runId: 'not-a-number' }) },
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 for a run id that does not exist', async () => {
    await asManager()
    const res = await importGet(
      new Request('http://localhost/api/imports/999999'),
      { params: Promise.resolve({ runId: '999999' }) },
    )
    expect(res.status).toBe(404)
  })
})
