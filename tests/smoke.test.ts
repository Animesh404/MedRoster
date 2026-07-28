import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('resolves the @/ path alias', async () => {
    const mod = await import('@/lib/domain/version')
    expect(mod.APP_NAME).toBe('MedRoster')
  })
})
