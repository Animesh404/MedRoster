import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Route modules pull in `@/lib/auth/session`, which imports the Supabase
// server client and therefore `next/headers` — unavailable outside a request
// scope, which is where this test imports them from. The brand check only
// inspects the exported function objects, so a null session is fine.
vi.mock('@/lib/auth/session', () => ({ currentSessionUser: () => Promise.resolve(null) }))

const { WITH_AUTH_BRAND } = await import('@/lib/auth/with-auth')
const { WITH_CRON_BRAND } = await import('@/lib/auth/with-cron-auth')

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
   * Routes that legitimately do NOT go through `withAuth`, each with a reason.
   *
   * An escape hatch, shaped to stay awkward. A route belongs here only when it
   * has no MedRoster session to authorize against — and it does NOT get to be
   * unguarded as a result: the assertions below hold it to the same standard,
   * a runtime brand on the real exported function, just a different brand.
   *
   * An earlier version of this exemption checked that the file's source
   * CONTAINED the guard's name. That was satisfied by a comment: a handler with
   * an empty body and the string `CRON_SECRET` in its JSDoc passed, deleting
   * rows for anyone on the internet. This file's own MIN-7 note explains why
   * source text is not evidence; the exemption must not be the one place that
   * forgets it.
   */
  const UNAUTHENTICATED_BY_DESIGN: Record<string, { reason: string; brand: symbol }> = {
    'app/api/cron/prune/route.ts': {
      reason: 'Invoked by Vercel Cron, which carries no user session; guarded by CRON_SECRET.',
      brand: WITH_CRON_BRAND,
    },
  }

  const files = allFiles.filter((f) => !(f in UNAUTHENTICATED_BY_DESIGN))
  const exemptPaths = Object.keys(UNAUTHENTICATED_BY_DESIGN)

  // Pins the list. Adding an exemption now fails here first, so it cannot be a
  // quiet one-line edit buried in an unrelated diff — it has to be stated twice,
  // deliberately.
  it('has exactly the exemptions it is meant to have', () => {
    expect(exemptPaths).toEqual(['app/api/cron/prune/route.ts'])
  })

  // A typo'd path would silently exempt nothing and guard nothing.
  it.each(exemptPaths)('%s (exempt) actually exists', (file) => {
    expect(allFiles, `${file} is exempted but is not a route file`).toContain(file)
  })

  it.each(exemptPaths)('%s exports handlers carrying its declared guard brand', async (file) => {
    const { reason, brand } = UNAUTHENTICATED_BY_DESIGN[file]!
    const mod: Record<string, unknown> = await import(`@/${file.replace(/\.ts$/, '')}`)

    const exported = HTTP_VERBS.filter((verb) => verb in mod)
    expect(exported.length, `${file} exports no HTTP handlers`).toBeGreaterThan(0)

    for (const verb of exported) {
      expect(
        (mod[verb] as Record<symbol, unknown>)[brand],
        `${file} ${verb} is exempt from withAuth (${reason}) but carries no guard brand`,
      ).toBe(true)
    }
  })

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
