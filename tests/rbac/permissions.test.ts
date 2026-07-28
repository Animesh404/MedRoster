import { describe, expect, it } from 'vitest'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, can } from '@/lib/auth/permissions'

const manager = { id: 1, role: 'MANAGER' as const, profession: null }
const staff   = { id: 2, role: 'STAFF' as const, profession: 'NURSE' as const }

describe('ROLE_PERMISSIONS', () => {
  it('gives a manager every permission', () => {
    for (const p of ALL_PERMISSIONS) expect(can(manager, p), p).toBe(true)
  })

  it('lets staff act only on their own claims', () => {
    expect(can(staff, 'claim:create:self')).toBe(true)
    expect(can(staff, 'claim:delete:self')).toBe(true)
    expect(can(staff, 'claim:create:any')).toBe(false)
    expect(can(staff, 'claim:delete:any')).toBe(false)
  })

  it('keeps staff out of shift management', () => {
    for (const p of ['shift:create', 'shift:update', 'shift:delete'] as const) {
      expect(can(staff, p), p).toBe(false)
    }
  })

  it('keeps staff out of the importer entirely', () => {
    expect(can(staff, 'import:run')).toBe(false)
    expect(can(staff, 'import:read')).toBe(false)
  })

  it('lets staff read shifts so they can find work', () => {
    expect(can(staff, 'shift:read')).toBe(true)
  })
})
