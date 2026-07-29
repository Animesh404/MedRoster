import { defineConfig, devices } from '@playwright/test'

/**
 * Browser-driven stress pass config. Deliberately NOT part of `vitest run` —
 * these specs drive the real, already-installed Chrome (via `channel:
 * 'chrome'`) against a running Next server rather than any unit-test
 * harness, so they live under their own `npm run test:e2e` script instead of
 * the default `npm test`.
 *
 * `webServer` is intentionally omitted: the stress pass needs to run the
 * SAME flow against both a production build (`npm run build && npm start`)
 * and `next dev` in turn, and needs full control over which port and env
 * each pass targets. `BASE_URL` is set by whoever launches the app.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3100',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
})
