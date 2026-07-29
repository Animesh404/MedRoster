# MedRoster
A web-based staff scheduling platform that enables clinic managers to create shifts, allows staff to claim available shifts, and imports existing schedules from spreadsheets for a seamless transition.

## Testing

- `npm test` — the full unit/integration suite (Vitest + Testcontainers Postgres). Run with `npx vitest run --no-file-parallelism` if running the whole suite in parallel contends for host resources.
- `npm run test:e2e` — a real-Chrome, browser-driven Playwright suite (`e2e/`) covering auth, optimistic claiming, manager flows, CSV import, week navigation, two-tab realtime, responsiveness and keyboard navigation. It drives the already-installed Google Chrome via Playwright's `channel: 'chrome'` (no bundled browser download) against a running `npm run build && npm start` (set `BASE_URL` to point at a different host/port). Kept out of `npm test` deliberately — it needs a live server and a real browser, so it stays a separate, slower, opt-in command.
