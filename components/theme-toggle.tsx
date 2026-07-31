'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Monitor, Moon, Sun } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  THEME_PREFERENCES,
  type ThemePreference,
} from '@/lib/theme/preference'

const LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

const ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

/**
 * Light / dark / system, available to everyone — signed in or not.
 *
 * Three things happen on a choice, in this order, and the order is the point:
 *
 *  1. **The DOM attribute changes immediately.** The theme has to flip on the
 *     click, not on a round trip. Everything below is about making the choice
 *     survive; this is about it being felt.
 *  2. **A cookie is written**, so the SERVER renders the right theme on the
 *     next navigation. Without this the choice would survive only as long as
 *     this DOM does, and the first full page load would throw it away.
 *  3. **A signed-in member's choice is saved to their account**, so it follows
 *     them to another browser. Anonymous visitors skip this and lose nothing —
 *     the cookie is the whole story for them.
 *
 * Step 3 is deliberately fire-and-forget. Nobody should watch a spinner to
 * change a colour scheme, and a failed save costs them a re-pick on the next
 * device rather than anything they can see now.
 */
export function ThemeToggle({
  current,
  persist = false,
}: {
  current: ThemePreference
  /** True when somebody is signed in, so the choice can follow their account. */
  persist?: boolean
}) {
  // `chosen` distinguishes "this member picked something" from "this is just
  // what the server rendered". Without it the effect below writes a cookie on
  // every mount, which makes "never chose" indistinguishable from "chose
  // system" — and sign-in then refuses to apply the stored preference, because
  // it looks like a choice made moments ago. Measured: the account said `dark`,
  // a fresh browser stayed on `system`.
  const [{ value: theme, chosen }, setTheme] =
    useState<{ value: ThemePreference; chosen: boolean }>({ value: current, chosen: false })
  const [, startTransition] = useTransition()
  const router = useRouter()

  // The DOM attribute and the cookie are SYNCHRONISED FROM STATE rather than
  // written in the click handler. Mutating `document` mid-handler is what the
  // React Compiler's immutability rule objects to, and it has a point: state is
  // the source of truth, and this is the one place that projects it outwards.
  useEffect(() => {
    document.documentElement.dataset.theme = theme

    // Only on an actual choice. An earlier version wrote it on every mount to
    // slide the expiry forward, which cost a member their saved preference on
    // any new browser — see the note on `chosen` above. A year-long cookie does
    // not need refreshing badly enough to pay that.
    if (!chosen) return

    // `SameSite=Lax` rather than Strict: somebody arriving from an emailed
    // invite link is a cross-site navigation, and Strict would withhold the
    // cookie on exactly that first render — the one where a wrong theme is
    // most jarring. `Secure` only over https, so localhost still works.
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie =
      `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
  }, [theme, chosen])

  function choose(next: ThemePreference) {
    // No early return when the value is unchanged. Picking "System" while
    // already showing system looks like a no-op but is not: it is the member
    // saying so, and it has to be recorded, or their account keeps whatever was
    // saved before and overrides them on the next sign-in. `chosen` flipping
    // false -> true is enough to re-run the effect below.
    setTheme({ value: next, chosen: true })

    if (persist) {
      void fetch('/api/me/theme', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: next }),
        // Deliberately unawaited and unhandled: see the note above. A rejected
        // promise still needs catching or it surfaces as an unhandled rejection.
      }).catch(() => {})
    }

    // Server components rendered under the old theme (anything that branches on
    // it) get re-rendered. Cheap, and keeps server and client from disagreeing.
    startTransition(() => router.refresh())
  }

  const Icon = ICONS[theme]

  return (
    <DropdownMenu>
      {/* Styled directly rather than wrapping a Button: this is base-ui, whose
          Trigger renders its own element and has no `asChild`. Matches how
          components/user-menu.tsx drives the same primitive. */}
      <DropdownMenuTrigger
        aria-label={`Theme: ${LABELS[theme]}`}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_PREFERENCES.map((value) => {
          const ItemIcon = ICONS[value]
          return (
            <DropdownMenuItem
              key={value}
              // `onClick`, NOT `onSelect`. Base UI's Menu.Item has no
              // Radix-style `onSelect`, and React's own DOMAttributes declares
              // a native `onSelect` on every element — so `onSelect` type-checks
              // perfectly and simply never fires. components/user-menu.tsx
              // carries the same warning; this component was written against it
              // anyway and shipped a menu where nothing happened on click.
              onClick={() => { choose(value) }}
              aria-current={theme === value ? 'true' : undefined}
            >
              <ItemIcon className="size-4" aria-hidden="true" />
              {LABELS[value]}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
