'use client'

import { LogOut, Settings } from 'lucide-react'
import Link from 'next/link'
import { signOutAction } from '@/app/(app)/actions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function UserMenu({ name, email, roleLabel }: { name: string; email: string; roleLabel: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
        >
          {initials(name)}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block leading-tight font-medium">{name}</span>
          <span className="block text-xs leading-tight text-muted-foreground">{roleLabel}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Base UI's `Menu.GroupLabel` (what `DropdownMenuLabel` renders)
         *  requires a `Menu.Group` ancestor — without one it throws
         *  "MenuGroupContext is missing" the instant the popup actually
         *  mounts (i.e. on the first real click, never during SSR), which
         *  crashed the whole menu and made sign-out unreachable. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-mono text-xs font-normal">{email}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuItem render={<Link href="/account" />}>
          <Settings aria-hidden />
          Account
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Base UI's `Menu.Item` only recognises `onClick` — it has no
         *  Radix-style `onSelect` prop. `onSelect` type-checks anyway
         *  because React's own `DOMAttributes<div>` declares a (native,
         *  input/textarea-only) `onSelect` event for every element, so
         *  `tsc` never flagged this; it simply never fired. */}
        <DropdownMenuItem onClick={() => void signOutAction()}>
          <LogOut aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
