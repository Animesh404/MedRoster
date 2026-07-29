import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Regression for a real, browser-only bug a server-side/SSR-only sweep can
 * never see: `/dashboard` used to wrap `DashboardContent` in
 * `<Suspense key={isoWeek}>` to show a loading skeleton during week-to-week
 * navigation. Once that boundary had settled (its normal state almost all
 * the time), a `router.refresh()` triggered by `WeekRealtimeSync`'s realtime
 * event / polling reconciliation silently did nothing: the server genuinely
 * re-executed `DashboardContent` with fresh data on every such refresh
 * (verified directly against a running `next start` server with a one-off
 * server-side log — a fresh execution timestamp landed on every refresh) and
 * the browser received a 200 for the refetch, but React never committed the
 * update through the already-resolved boundary, so the dashboard just sat
 * stale forever. Confirmed by contrast: `/my-shifts`, which has no
 * `<Suspense>` at all, applies the exact same kind of realtime-triggered
 * `router.refresh()` correctly — proven with the identical debug harness.
 *
 * This is exactly the plan's own acceptance scenario ("a nurse claims a
 * shift, the manager's dashboard updates without a reload" — §CRITICAL-1),
 * so `app/(app)/dashboard/page.tsx` must never re-grow a `<Suspense>`
 * boundary around `DashboardContent`. `e2e/realtime.spec.ts` is the real,
 * end-to-end regression test (drives two actual browser tabs against a real
 * server); this is the fast, source-level guard `tests/rbac/routes.test.ts`
 * and `tests/seed/seed-wiring.test.ts` use the same trade-off for — not
 * proof the live update works, but a guard against the exact wiring that
 * broke it regressing silently again.
 */
describe('dashboard page realtime-refresh wiring', () => {
  it('does not import Suspense from react (the actual usage, not just prose mentioning it)', () => {
    const src = readFileSync('app/(app)/dashboard/page.tsx', 'utf8')
    expect(
      src,
      'a <Suspense> boundary here swallows router.refresh() once settled — see the comment above DashboardPage',
    ).not.toMatch(/import\s*\{[^}]*\bSuspense\b[^}]*\}\s*from\s*['"]react['"]/)
  })

  it('declares itself force-dynamic, so router.refresh() always hits a fresh render', () => {
    const src = readFileSync('app/(app)/dashboard/page.tsx', 'utf8')
    expect(src).toContain("export const dynamic = 'force-dynamic'")
  })

  it('WeekRealtimeSync wraps its router.refresh() calls in startTransition', () => {
    // Fires from a setInterval tick or a broadcast callback, never a React
    // event handler — startTransition is what makes React treat the update
    // as a real pending navigation.
    const src = readFileSync('components/realtime/week-realtime-sync.tsx', 'utf8')
    const refreshCalls = src.match(/router\.refresh\(\)/g) ?? []
    expect(refreshCalls.length).toBeGreaterThan(0)
    for (const _ of refreshCalls) {
      expect(src).toContain('startTransition(() => router.refresh())')
    }
  })
})
