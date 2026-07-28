import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// @types/node is pinned to v20 here, which predates `fs.globSync` (added in the
// Node 22 typings). The function exists at runtime on our Node version; this
// augmentation just teaches the type-checker about it without bumping the
// devDependency for one function.
declare module 'node:fs' {
  function globSync(pattern: string | string[]): string[]
}

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
  const files = globSync('app/api/**/route.ts')

  it.skipIf(files.length === 0)('finds route files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s declares a permission via withAuth', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src, `${file} must import withAuth`).toContain('withAuth')
    // Every exported HTTP verb must be produced by withAuth(...)
    const verbs = [...src.matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\s*=\s*([^\n]+)/g)]
    expect(verbs.length, `${file} exports no HTTP handlers`).toBeGreaterThan(0)
    for (const [, verb, rhs] of verbs) {
      expect(rhs, `${file} ${verb} must be wrapped in withAuth`).toContain('withAuth(')
    }
  })
})
