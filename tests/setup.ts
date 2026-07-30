import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom component tests render into a shared document; without an explicit
// cleanup a later test in the same file inherits the previous test's DOM
// (e.g. two elements matching `role="status"` instead of one).
afterEach(() => {
  cleanup()
})

// Server-side auth configuration the app now requires at boot. Unit tests
// never reach the real Supabase stack — the clients are mocked — but
// `getServerEnv()` validates these eagerly, so absent defaults every
// DB-backed test file would fail on config rather than on the behaviour it
// is testing.
//
// Do NOT add `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
// defaults here. `hooks/use-realtime.ts` reads `getClientEnv()` at MODULE
// SCOPE and freezes the result into `HAS_SUPABASE` once, for the lifetime of
// the whole test process — it is not read per-test or per-render. Defaulting
// those two here flips `HAS_SUPABASE` to true for every test file in the
// suite, silently rewiring every component under test from the polling code
// path onto the websocket/realtime code path. That is precisely what
// regressed `tests/ui/week-realtime-sync.test.tsx` after Task 1 first added
// these lines: its polling-based assertions stopped seeing `router.refresh()`
// fire because the hook had quietly stopped polling at all. If a test
// genuinely needs those two client variables, set them within that test
// file, not here.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key'
process.env.APP_URL ??= 'http://localhost:3000'

// resolveDatabase() falls back to this only when DATABASE_URL is unset. Every
// DB-backed test file gets a throwaway Testcontainers DATABASE_URL, which wins
// by precedence — so this exists purely so getServerEnv() can resolve in tests
// that never touch a database. A bogus host is deliberate: if anything ever
// does try to connect through it, it fails loudly rather than silently.
process.env.DATABASE_URL_DEV ??= 'postgresql://unused:unused@127.0.0.1:1/unused'
