import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      // `server-only` is a build-time guard for the Next bundler: it throws on
      // import unless resolved under the `react-server` export condition,
      // which Next sets and Vitest does not. Routes that reach the Supabase
      // admin client (which opens with `import 'server-only'`) would
      // otherwise fail to even load under Vitest — including in
      // tests/rbac/routes.test.ts's dynamic import of every route module.
      // The real protection against the service-role key reaching the client
      // bundle is tests/auth/admin-containment.test.ts, which statically
      // walks the import graph and is unaffected by this alias.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
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
    // One test file at a time. Every DB-backed file boots its own Testcontainers
    // Postgres, and running several at once contends for host CPU and disk hard
    // enough to time out container startup — a flake with nothing to do with the
    // code under test. The whole suite still finishes in well under a minute, and
    // `npm test` being reliable on a stranger's machine is worth more than the
    // parallel speedup.
    fileParallelism: false,
  },
})
