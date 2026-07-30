import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

declare module 'node:fs' {
  function globSync(pattern: string | string[]): string[]
}

const ADMIN_MODULE = '@/lib/supabase/admin'

/**
 * The service-role key bypasses every access rule Supabase enforces. If it
 * reaches the client bundle it is world-readable and cannot be un-leaked —
 * rotating it is the only remedy. A comment asking people not to import this
 * module is not a control; this test is.
 *
 * Deliberately a source scan rather than a bundle inspection: it fails in
 * `npm test` the moment the import is written, instead of after a build.
 */
describe('service-role client containment', () => {
  const sources = globSync(['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'])

  it('finds source files to check', () => {
    expect(sources.length).toBeGreaterThan(0)
  })

  const importers = sources.filter((file) => readFileSync(file, 'utf8').includes(ADMIN_MODULE))

  it('is never imported by a "use client" module', () => {
    const offenders = importers.filter((file) => {
      const src = readFileSync(file, 'utf8')
      return /^\s*['"]use client['"]/m.test(src)
    })
    expect(offenders, `these client modules import ${ADMIN_MODULE}`).toEqual([])
  })

  it('is never imported by a React component file', () => {
    const offenders = importers.filter((file) => file.endsWith('.tsx'))
    expect(offenders, `.tsx files must not import ${ADMIN_MODULE}`).toEqual([])
  })
})
