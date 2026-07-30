import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom component tests render into a shared document; without an explicit
// cleanup a later test in the same file inherits the previous test's DOM
// (e.g. two elements matching `role="status"` instead of one).
afterEach(() => {
  cleanup()
})

// Auth configuration the app now requires at boot. Unit tests never reach the
// real Supabase stack — the clients are mocked — but `getServerEnv()` validates
// eagerly, so absent defaults every DB-backed test file would fail on config
// rather than on the behaviour it is testing.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key'
process.env.APP_URL ??= 'http://localhost:3000'
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable-key'
