import { readFileSync } from 'node:fs'
import { getDMMF } from '@prisma/internals'
import { beforeAll, describe, expect, it } from 'vitest'

// NOTE: Prisma 7's generated `@prisma/client` runtime DMMF (`Prisma.dmmf`) is
// intentionally slimmed down for bundle size and no longer carries
// `uniqueFields`/index metadata on models. We parse the schema with
// `@prisma/internals#getDMMF` (the same engine the CLI uses) to get the full
// DMMF the brief's assertions depend on. See task-2-report.md for details.
describe('prisma schema', () => {
  let models: Awaited<ReturnType<typeof getDMMF>>['datamodel']['models']

  beforeAll(async () => {
    const datamodel = readFileSync('prisma/schema.prisma', 'utf-8')
    const dmmf = await getDMMF({ datamodel })
    models = dmmf.datamodel.models
  })

  const byName = (n: string) => models.find((m) => m.name === n)

  it('defines every model the spec requires', () => {
    for (const n of ['User','Shift','ShiftRequirement','Claim','ShiftSeries','ImportRun','ImportRowResult','EventOutbox']) {
      expect(byName(n), `missing model ${n}`).toBeDefined()
    }
  })

  it('makes a user unable to hold the same shift twice', () => {
    expect(byName('Claim')!.uniqueFields).toContainEqual(['shiftId', 'userId'])
  })

  it('allows only one requirement row per profession per shift', () => {
    expect(byName('ShiftRequirement')!.uniqueFields).toContainEqual(['shiftId', 'profession'])
  })

  it('versions shifts so edit previews can detect concurrent writes', () => {
    expect(byName('Shift')!.fields.find((f) => f.name === 'version')).toBeDefined()
  })
})
