import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000, // Testcontainers pulls an image on first run
    // Vitest's default hookTimeout (10s) is too tight for `beforeEach(resetTestDb)`:
    // every DB-backed test file boots its own Testcontainers Postgres, and when
    // many files run in parallel their container-startup/migration work contends
    // for host CPU/disk, occasionally pushing a single file's first hook call
    // past 10s. Observed directly: under full-suite parallel load, pre-existing
    // files unrelated to any business logic (e.g. tests/import/apply.test.ts)
    // hit this same "Hook timed out in 10000ms" — proof it's host contention,
    // not a race in the code under test.
    hookTimeout: 60_000,
  },
})
