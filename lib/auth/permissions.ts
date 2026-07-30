import type { Profession, Role } from '@prisma/client'

export const ALL_PERMISSIONS = [
  'shift:read', 'shift:create', 'shift:update', 'shift:delete',
  'claim:create:self', 'claim:create:any',
  'claim:delete:self', 'claim:delete:any',
  'import:run', 'import:read',
  'staff:read',
  // Manager-only. `staff:read` above is deliberately NOT one of these: it is a
  // STAFF-level directory of names and professions for the assignment UI, and
  // it must not grow into "read every colleague's email and account state".
  'member:read', 'member:invite', 'member:manage',
] as const

export type Permission = (typeof ALL_PERMISSIONS)[number]

export interface Principal {
  id: number
  role: Role
  profession: Profession | null
}

const STAFF_PERMISSIONS: Permission[] = [
  'shift:read',
  'claim:create:self',
  'claim:delete:self',
  'staff:read',
]

/**
 * The single source of truth for who may do what. Imported by the server to
 * enforce and by the client to disable controls, so the button a user cannot
 * press and the endpoint that would reject them never disagree. §6.3
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  MANAGER: new Set(ALL_PERMISSIONS),
  STAFF: new Set(STAFF_PERMISSIONS),
}

export function can(principal: Principal | null | undefined, permission: Permission): boolean {
  if (!principal) return false
  return ROLE_PERMISSIONS[principal.role].has(permission)
}

/**
 * Resolves a `:self`/`:any` pair for a target user. Returns the permission that
 * actually applies, so callers ask one question instead of branching on role.
 */
export function scopedPermission(
  principal: Principal,
  base: 'claim:create' | 'claim:delete',
  targetUserId: number,
): Permission {
  return principal.id === targetUserId ? `${base}:self` : `${base}:any`
}
