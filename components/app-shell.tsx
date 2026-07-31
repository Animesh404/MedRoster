import Link from 'next/link'
import type { ReactNode } from 'react'
import { can, type Permission, type Principal } from '@/lib/auth/permissions'
import { UserMenu } from '@/components/user-menu'
import { ThemeToggle } from '@/components/theme-toggle'
import type { ThemePreference } from '@/lib/theme/preference'

interface NavItem {
  href: string
  label: string
  permission: Permission
  /**
   * An extra applicability check, for links a user is *allowed* to open but
   * which can never hold anything for them. Permission answers "may they?";
   * this answers "is there any point?".
   */
  applies?: (principal: Principal) => boolean
}

/**
 * The same permission catalogue the API enforces gates what a user sees here
 * — a staff member is never shown "New shift" or "Import" only to have the
 * server 403 it. §lib/auth/permissions.ts
 */
const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', permission: 'shift:read' },
  {
    href: '/my-shifts',
    label: 'My shifts',
    permission: 'claim:create:self',
    // Managers hold every permission, so the permission check alone let them
    // through — to a page that can never have content. A shift requires a
    // profession, and a manager has none, so `validateAssignment` rejects them
    // with PROFESSION_NOT_REQUIRED. The page was therefore permanently empty and
    // told them to "claim a shift", which is the one thing they cannot do.
    applies: (p) => p.profession !== null,
  },
  { href: '/shifts/new', label: 'New shift', permission: 'shift:create' },
  { href: '/import', label: 'Import', permission: 'import:read' },
  { href: '/members', label: 'Members', permission: 'member:read' },
]

const ROLE_LABEL: Record<Principal['role'], string> = {
  MANAGER: 'Manager',
  STAFF: 'Staff',
}

export function AppShell({
  principal,
  name,
  email,
  theme,
  children,
}: {
  principal: Principal
  name: string
  email: string
  theme: ThemePreference
  children: ReactNode
}) {
  const items = NAV_ITEMS.filter(
    (item) => can(principal, item.permission) && (item.applies?.(principal) ?? true),
  )
  const roleLabel = principal.profession
    ? `${principal.profession[0]}${principal.profession.slice(1).toLowerCase()}`
    : ROLE_LABEL[principal.role]

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-brand-deep dark:text-brand-mid"
          >
            <span
              aria-hidden
              className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-primary text-xs font-bold text-white"
            >
              M
            </span>
            MedRoster
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-1">
            {/* `persist` because there is a signed-in member here whose choice
                should follow them to another browser. */}
            <ThemeToggle current={theme} persist />
            <UserMenu name={name} email={email} roleLabel={roleLabel} />
          </div>
        </div>

        <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto px-4 pb-2 sm:hidden">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium text-foreground/80 hover:bg-accent hover:text-accent-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
