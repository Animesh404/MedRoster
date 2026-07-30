import { globSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path/posix'
import { describe, expect, it } from 'vitest'

declare module 'node:fs' {
  function globSync(pattern: string | string[]): string[]
}

/** Repo-relative path to the module this whole test exists to fence off. */
const ADMIN_MODULE = 'lib/supabase/admin.ts'

/** Repo-relative file path -> source text. Keys use forward slashes throughout. */
export type FileMap = Record<string, string>

/**
 * Extracts every import/re-export module specifier from a source file:
 * `import x from '...'`, `export * from '...'`, bare `import '...'`, and
 * dynamic `import('...')`. This is a heuristic text scan rather than a real
 * parser, matching the spirit of the test it serves: it should catch any
 * plausible-looking import rather than depend on a full TS/JS toolchain.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

/**
 * Resolves an import specifier to a repo-relative module path, trying the
 * extensions a bundler would (`.ts`, `.tsx`, `/index.ts`, `/index.tsx`).
 * Returns null for specifiers that don't resolve inside `files` — bare
 * package imports (`react`, `server-only`, `next/headers`) and anything that
 * genuinely doesn't exist. `@/` is this repo's tsconfig alias for the repo
 * root (see `paths` in tsconfig.json), so `@/x` resolves the same as `x`.
 */
export function resolveImportSpecifier(
  specifier: string,
  importerPath: string,
  files: FileMap,
): string | null {
  let base: string
  if (specifier.startsWith('@/')) {
    base = specifier.slice(2)
  } else if (specifier.startsWith('.')) {
    base = normalize(join(dirname(importerPath), specifier))
  } else {
    return null
  }

  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate
  }
  return null
}

/** Builds the forward import graph: file -> the resolved files it imports. */
export function buildImportGraph(files: FileMap): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const [file, source] of Object.entries(files)) {
    const resolved = new Set(
      extractImportSpecifiers(source)
        .map((specifier) => resolveImportSpecifier(specifier, file, files))
        .filter((resolvedPath): resolvedPath is string => resolvedPath !== null),
    )
    graph.set(file, [...resolved])
  }
  return graph
}

/**
 * True when `file` is reachable from the client bundle on its own terms: a
 * `'use client'` directive as the first non-comment, non-blank statement, or
 * any `.tsx` file — a React component can be pulled into the client graph
 * even without the directive (e.g. imported by another client component).
 */
export function isClientReachable(file: string, source: string): boolean {
  if (file.endsWith('.tsx')) return true
  return startsWithUseClientDirective(source)
}

function startsWithUseClientDirective(source: string): boolean {
  let i = 0
  const len = source.length
  for (;;) {
    while (i < len && /\s/.test(source[i]!)) i++
    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? len : nl + 1
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? len : end + 2
      continue
    }
    break
  }
  return /^['"]use client['"]\s*;?/.test(source.slice(i))
}

/**
 * Shortest import chain from `from` to `to` over the resolved graph, guarded
 * against cycles with a visited set. Returns null if `to` isn't reachable.
 */
function findChain(graph: Map<string, string[]>, from: string, to: string): string[] | null {
  const queue: string[][] = [[from]]
  const visited = new Set<string>([from])
  while (queue.length > 0) {
    const path = queue.shift()!
    const last = path[path.length - 1]!
    if (last === to) return path
    for (const next of graph.get(last) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push([...path, next])
    }
  }
  return null
}

export interface AdminContainmentViolation {
  file: string
  chain: string[]
}

/**
 * Finds every client-reachable file that transitively imports `adminModule`.
 * Follows the resolved import graph rather than a first-order string match
 * on the file's own text, so neither a relative import nor an intermediate
 * server-only wrapper module can hide the path from a client component.
 * Cycles are guarded with visited sets in both the reachability walk and the
 * chain reconstruction, so a cyclic server-only module graph terminates
 * instead of hanging.
 */
export function findAdminContainmentViolations(
  files: FileMap,
  adminModule: string,
): AdminContainmentViolation[] {
  const graph = buildImportGraph(files)

  // Reverse the graph and BFS from adminModule to find every file that can
  // reach it transitively, however deep the chain.
  const reverse = new Map<string, string[]>()
  for (const [importer, imported] of graph) {
    for (const target of imported) {
      const list = reverse.get(target)
      if (list) list.push(importer)
      else reverse.set(target, [importer])
    }
  }

  const reachesAdmin = new Set<string>()
  const queue = [adminModule]
  const visited = new Set<string>([adminModule])
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const importer of reverse.get(current) ?? []) {
      if (visited.has(importer)) continue
      visited.add(importer)
      reachesAdmin.add(importer)
      queue.push(importer)
    }
  }

  const violations: AdminContainmentViolation[] = []
  for (const file of reachesAdmin) {
    const source = files[file]
    if (source === undefined) continue
    if (!isClientReachable(file, source)) continue
    violations.push({ file, chain: findChain(graph, file, adminModule) ?? [file, adminModule] })
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * The service-role key bypasses every access rule Supabase enforces. If it
 * reaches the client bundle it is world-readable and cannot be un-leaked —
 * rotating it is the only remedy. A comment asking people not to import this
 * module is not a control; this test is.
 *
 * Detection walks the resolved import graph transitively (not a substring
 * match on `@/lib/supabase/admin`), so it still catches a relative import,
 * or a plain server-side wrapper module that itself imports admin.ts and is
 * then pulled into a client component. See `findAdminContainmentViolations`
 * above — it is a pure function over an in-memory file map, unit-tested
 * below against synthetic fixtures before it's ever pointed at the real repo.
 *
 * Deliberately a source scan rather than a bundle inspection: it fails in
 * `npm test` the moment the import is written, instead of after a build.
 */
describe('service-role client containment', () => {
  describe('detection logic', () => {
    const admin: FileMap = { [ADMIN_MODULE]: readFileSync(ADMIN_MODULE, 'utf8') }

    it('detects a "use client" .tsx file importing admin via the @/ alias', () => {
      const files: FileMap = {
        ...admin,
        'components/widget/leak-alias.tsx': [
          `'use client'`,
          ``,
          `import { createSupabaseAdminClient } from '@/lib/supabase/admin'`,
          ``,
          `export function Widget() {`,
          `  createSupabaseAdminClient()`,
          `  return null`,
          `}`,
        ].join('\n'),
      }

      const violations = findAdminContainmentViolations(files, ADMIN_MODULE)

      expect(violations.map((v) => v.file)).toEqual(['components/widget/leak-alias.tsx'])
      expect(violations[0]!.chain).toEqual(['components/widget/leak-alias.tsx', ADMIN_MODULE])
    })

    it('detects a "use client" .tsx file importing admin via a relative path', () => {
      // Regression case for finding 1: a relative specifier contains no
      // substring match on '@/lib/supabase/admin' and must still be caught.
      const files: FileMap = {
        ...admin,
        'app/(app)/leak-relative.tsx': [
          `'use client'`,
          ``,
          `import { createSupabaseAdminClient } from '../../lib/supabase/admin'`,
          ``,
          `export function LeakRelative() {`,
          `  createSupabaseAdminClient()`,
          `  return null`,
          `}`,
        ].join('\n'),
      }

      const violations = findAdminContainmentViolations(files, ADMIN_MODULE)

      expect(violations.map((v) => v.file)).toEqual(['app/(app)/leak-relative.tsx'])
      expect(violations[0]!.chain).toEqual(['app/(app)/leak-relative.tsx', ADMIN_MODULE])
    })

    it('detects a "use client" .tsx file importing a plain .ts wrapper that imports admin', () => {
      // Regression case for finding 2: lib/supabase/session.ts is neither
      // 'use client' nor .tsx, so it must not be where detection stops.
      const files: FileMap = {
        ...admin,
        'lib/supabase/session.ts': [
          `import { createSupabaseAdminClient } from '@/lib/supabase/admin'`,
          ``,
          `export function getServiceRoleSession() {`,
          `  return createSupabaseAdminClient()`,
          `}`,
        ].join('\n'),
        'components/widget/leak-wrapper.tsx': [
          `'use client'`,
          ``,
          `import { getServiceRoleSession } from '@/lib/supabase/session'`,
          ``,
          `export function Widget() {`,
          `  getServiceRoleSession()`,
          `  return null`,
          `}`,
        ].join('\n'),
      }

      const violations = findAdminContainmentViolations(files, ADMIN_MODULE)

      expect(violations.map((v) => v.file)).toEqual(['components/widget/leak-wrapper.tsx'])
      expect(violations[0]!.chain).toEqual([
        'components/widget/leak-wrapper.tsx',
        'lib/supabase/session.ts',
        ADMIN_MODULE,
      ])
    })

    it('detects a chain three modules deep ending at a client component', () => {
      const files: FileMap = {
        ...admin,
        'lib/chain/wrapper-b.ts': [
          `import { createSupabaseAdminClient } from '@/lib/supabase/admin'`,
          ``,
          `export function b() {`,
          `  return createSupabaseAdminClient()`,
          `}`,
        ].join('\n'),
        'lib/chain/wrapper-a.ts': [
          `import { b } from '@/lib/chain/wrapper-b'`,
          ``,
          `export function a() {`,
          `  return b()`,
          `}`,
        ].join('\n'),
        'components/widget/leak-chain.tsx': [
          `'use client'`,
          ``,
          `import { a } from '@/lib/chain/wrapper-a'`,
          ``,
          `export function Widget() {`,
          `  a()`,
          `  return null`,
          `}`,
        ].join('\n'),
      }

      const violations = findAdminContainmentViolations(files, ADMIN_MODULE)

      expect(violations.map((v) => v.file)).toEqual(['components/widget/leak-chain.tsx'])
      expect(violations[0]!.chain).toEqual([
        'components/widget/leak-chain.tsx',
        'lib/chain/wrapper-a.ts',
        'lib/chain/wrapper-b.ts',
        ADMIN_MODULE,
      ])
    })

    it('does not flag a server-only .ts file importing admin directly', () => {
      const files: FileMap = {
        ...admin,
        'lib/server/reports.ts': [
          `import 'server-only'`,
          `import { createSupabaseAdminClient } from '@/lib/supabase/admin'`,
          ``,
          `export function runServiceReport() {`,
          `  return createSupabaseAdminClient()`,
          `}`,
        ].join('\n'),
      }

      expect(findAdminContainmentViolations(files, ADMIN_MODULE)).toEqual([])
    })

    it('does not hang on an import cycle among server modules that reaches admin, and does not flag it', () => {
      const files: FileMap = {
        ...admin,
        'lib/server/cycle-a.ts': [
          `import { b } from '@/lib/server/cycle-b'`,
          `import { createSupabaseAdminClient } from '@/lib/supabase/admin'`,
          ``,
          `export function a(): unknown {`,
          `  createSupabaseAdminClient()`,
          `  return b()`,
          `}`,
        ].join('\n'),
        'lib/server/cycle-b.ts': [
          `import { a } from '@/lib/server/cycle-a'`,
          ``,
          `export function b(): unknown {`,
          `  return a()`,
          `}`,
        ].join('\n'),
      }

      expect(findAdminContainmentViolations(files, ADMIN_MODULE)).toEqual([])
    })
  })

  describe('real repository', () => {
    const sources = globSync(['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'])

    it('finds source files to check', () => {
      expect(sources.length).toBeGreaterThan(0)
    })

    it('is never reachable from the client bundle, directly or transitively', () => {
      const files: FileMap = Object.fromEntries(sources.map((file) => [file, readFileSync(file, 'utf8')]))

      const violations = findAdminContainmentViolations(files, ADMIN_MODULE)

      const report = violations
        .map((v) => `  ${v.file}\n    chain: ${v.chain.join(' -> ')}`)
        .join('\n')
      expect(violations, `${ADMIN_MODULE} is reachable from the client bundle:\n${report}`).toEqual([])
    })
  })
})
