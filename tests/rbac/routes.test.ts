import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Route modules pull in `@/lib/auth/session`, which imports the Supabase
// server client and therefore `next/headers` — unavailable outside a request
// scope, which is where this test imports them from. The brand check only
// inspects the exported function objects, so a null session is fine.
vi.mock('@/lib/auth/session', () => ({ currentSessionUser: () => Promise.resolve(null) }))

const { WITH_AUTH_BRAND } = await import('@/lib/auth/with-auth')

// @types/node is pinned to v20 here, which predates `fs.globSync` (added in the
// Node 22 typings). The function exists at runtime on our Node version; this
// augmentation just teaches the type-checker about it without bumping the
// devDependency for one function.
declare module 'node:fs' {
  function globSync(pattern: string | string[]): string[]
}

const HTTP_VERBS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const

/**
 * Structural guard: every API route file must route its handlers through
 * withAuth. A new endpoint that forgets its permission fails here rather
 * than shipping open. §6.3
 *
 * No app/api/**\/route.ts files exist yet as of Task 9 — they arrive in
 * Task 12. `it.skipIf` lets the suite stay green until then while
 * documenting why, and the per-file assertion below still fails loudly the
 * moment any route file appears without a withAuth-wrapped handler.
 */
describe('API route authorisation coverage', () => {
  const allFiles = globSync('app/api/**/route.ts')

  /**
   * Routes that legitimately do NOT go through `withAuth`, each with the reason.
   *
   * This is an escape hatch, and it is deliberately shaped to be an awkward
   * one: adding an entry is a visible, reviewable edit to the very test that
   * exists to stop routes shipping unguarded. A route belongs here only when it
   * has no MedRoster session to authorize against AND enforces its own check —
   * never merely because `withAuth` was inconvenient.
   *
   * Every exempt route is still asserted below to carry SOME authorization.
   */
  const UNAUTHENTICATED_BY_DESIGN: Record<string, { reason: string; guard: string }> = {
    'app/api/cron/prune/route.ts': {
      reason: 'Invoked by Vercel Cron, which carries no user session.',
      guard: 'CRON_SECRET',
    },
  }

  const files = allFiles.filter((f) => !(f in UNAUTHENTICATED_BY_DESIGN))
  const exempt = allFiles.filter((f) => f in UNAUTHENTICATED_BY_DESIGN)

  // An exemption is not permission to be unguarded — it only changes WHICH
  // guard is required. Without this, the allowlist would be a way to ship an
  // open endpoint by adding one line.
  it.each(exempt)('%s is exempt from withAuth but enforces its own guard', (file) => {
    const src = readFileSync(file, 'utf8')
    const { guard } = UNAUTHENTICATED_BY_DESIGN[file]!
    expect(src, `${file} is exempt but references no guard`).toContain(guard)
    // And it must refuse when the secret is absent, rather than running open.
    expect(src, `${file} must refuse to run when ${guard} is unset`).toMatch(/if \s*\(!\s*\w+\)/)
  })

  it.skipIf(files.length === 0)('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // Cheap first line: a route written as `export const GET = withAuth(...)`
  // must contain the literal text. Kept because it's a fast, readable smoke
  // check, but it is NOT the real guard (MIN-7): it's evadable by
  // `export { GET }` re-exporting a handler defined elsewhere, or simply by
  // reformatting the call across lines so the literal substring vanishes
  // from what the regex sees on a single line.
  it.each(files)('%s declares a permission via withAuth (regex smoke check)', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src, `${file} must import withAuth`).toContain('withAuth')
    const verbs = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\s*=\s*([^\n]+)/g)]
    expect(verbs.length, `${file} exports no HTTP handlers`).toBeGreaterThan(0)
    for (const [, verb, rhs] of verbs) {
      expect(rhs, `${file} ${verb} must be wrapped in withAuth`).toContain('withAuth(')
    }
  })

  // The real guard: import the actual module and check the actual exported
  // function object carries the brand `withAuth` stamps on everything it
  // returns. This can't be fooled by re-exports or reformatting — it
  // inspects the runtime value a client would actually invoke, not source
  // text that merely looks right.
  it.each(files)('%s exports handlers actually produced by withAuth (brand check)', async (file) => {
    // `file` is already a cwd-relative posix path from globSync (e.g.
    // "app/api/shifts/route.ts"); the "@/*" tsconfig path alias maps 1:1
    // onto that, resolved here by vite-tsconfig-paths same as any other
    // `@/...` import in this codebase.
    const specifier = `@/${file.replace(/\.ts$/, '')}`
    const mod: Record<string, unknown> = await import(specifier)

    const exportedVerbs = HTTP_VERBS.filter((verb) => verb in mod)
    expect(exportedVerbs.length, `${file} exports no HTTP handlers`).toBeGreaterThan(0)

    for (const verb of exportedVerbs) {
      const handler = mod[verb]
      expect(typeof handler, `${file} ${verb} must be a function`).toBe('function')
      expect(
        (handler as Record<symbol, unknown>)[WITH_AUTH_BRAND],
        `${file} ${verb} must be produced by withAuth (missing brand)`,
      ).toBe(true)
    }
  })
})
