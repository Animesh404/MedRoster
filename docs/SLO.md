# Service level objectives

What MedRoster promises, in numbers that a build can check. `scripts/slo-check.ts`
measures these against a running instance and fails the go-live gate when a
budget is breached, so a regression stops a deploy rather than being discovered
by a manager on a Monday morning.

These are objectives for **a small clinic's rota**, not for a high-traffic
service. The load is a handful of concurrent staff; the thing that actually
hurts is a page that stalls while somebody is trying to claim a shift before
someone else does.

---

## SLI 1 — Availability

**Indicator:** the fraction of `GET /api/health` probes returning `200`.

**Objective:** 100% during the gate. 99.5% monthly in production.

The probe runs a real `SELECT 1`, so it fails when the database is unreachable
even though the Node process is fine. That distinction is the point: an
instance that is up but cannot reach Postgres serves nothing worth having, and
a liveness-only check would go green through exactly the outage worth catching.

Any non-200 fails the gate. There is no partial credit — a deploy that cannot
answer its own health check must not go live.

## SLI 2 — Latency

**Indicator:** wall-clock time to a complete response, measured from the client.

**Objectives**, by route class:

| Route class | p95 | p99 | Why this number |
|---|---|---|---|
| `/api/health` | 500 ms | 1000 ms | One `SELECT 1` plus framework overhead. Slower than this means the database round trip is degrading, which precedes it failing. |
| Public pages (`/`, `/login`) | 1500 ms | 2500 ms | Server-rendered, unauthenticated, and the first thing anybody sees. |

Measured after a warm-up pass whose samples are discarded. A cold Next.js
server's first request compiles and connects, and holding a deploy for that
would fail every run for a reason that never affects a user.

**What this deliberately does not cover:** authenticated pages — `/dashboard`,
`/my-shifts`, `/shifts/[id]`. Measuring them needs a real Supabase session, and
a latency probe that fakes one measures a code path nobody runs. Their
behaviour is covered functionally by the Playwright suite, which fails on any
5xx or console error. This is a real gap in the gate, stated rather than
papered over: a dashboard that got slow but not broken would pass.

## SLI 3 — Error rate

**Indicator:** the fraction of requests returning 5xx, across every request the
gate makes — the SLO probes and the full Playwright run.

**Objective:** zero.

A 5xx is a server-side defect by definition. At this traffic level there is no
error budget to spend: one 5xx in a gate run is one more than the app should
ever produce, and the Playwright fixtures already fail a spec on any unexpected
failed request.

## SLI 4 — Deploy integrity

**Indicator:** the `commit` reported by `/api/health` on the live deployment.

**Objective:** exactly matches the commit the gate ran against.

A green pipeline proves the artefact was good, not that it reached production.
This closes the gap between the two — a deploy that silently rolled back, or
went to the wrong project, is caught by asking the running service which build
it is.

---

## Two profiles

The same budgets cannot serve both places this runs. The gate measures a Node
server and a Postgres on one machine; production measures a serverless function
reaching a hosted database across a network, cold start included.

| | health p95 / p99 | public pages p95 / p99 |
|---|---|---|
| `local` (the gate's acceptance job) | 300 / 600 ms | 800 / 1200 ms |
| `production` (post-deploy) | 500 / 1000 ms | 1500 / 2500 ms |

The profile is picked from `BASE_URL` — anything not localhost is treated as a
real deployment — and can be forced with `SLO_PROFILE`.

The local budgets keep a wide margin over what a warm laptop measures (single
figures in milliseconds) on purpose. A loaded CI runner is not a warm laptop,
and a latency check that fails on a busy runner teaches people to re-run it
until it goes green, which is worse than not having one. They are still tight
enough to catch a tenfold regression, which is the failure worth stopping.

## Function and database must share a region

The first production SLO run **failed** — health p95 648 ms against a 500 ms
budget — and the diagnosis is worth keeping, because the budget was right and
the deployment was wrong.

The request path was: user → Mumbai edge (`bom1`) → **function in Washington
(`iad1`)** → **database in Tokyo (`ap-northeast-1`)**. `checkedInMs`, the
server-side timing of a single `SELECT 1`, sat at a steady 150 ms — that is one
Washington–Tokyo round trip, paid by every query on every page, several times
over on a page like the dashboard.

`vercel.json` now pins `regions: ["hnd1"]`, colocating the function with the
database. `checkedInMs` fell from 150 ms to **6 ms** and health p95 from 648 ms
to 270 ms.

The general rule: **pin the function region to the database's**. Users pay one
extra hop to reach a further edge; a mislocated function pays a transcontinental
hop per query. If the database ever moves, this setting moves with it.

This is what an SLO is for. The tempting fix was to raise the budget until it
went green, which would have shipped a deployment three times slower than it
needed to be and called it healthy.

## Running the checks

```bash
BASE_URL=http://localhost:3100 npm run slo                    # local profile
BASE_URL=https://… EXPECT_COMMIT=$(git rev-parse HEAD) npm run slo   # + SLI 4
```

Exits non-zero on the first breached budget and prints the measured
distribution against it, so a failure says which number moved and by how much.
Verified to fail, not just to pass: a breached latency budget, an unreachable
instance and a commit mismatch each exit 1.
