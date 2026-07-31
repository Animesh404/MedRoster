/**
 * Measures the service level objectives in docs/SLO.md against a running
 * instance and exits non-zero when one is breached.
 *
 * The go-live gate runs this between "the tests passed" and "deploy it". Its
 * whole job is to be the thing that says no: a build can typecheck, lint, pass
 * 750 unit tests and a full browser suite while still answering its own health
 * check in two seconds, and none of those would notice.
 *
 * Usage:  BASE_URL=http://localhost:3100 npx tsx scripts/slo-check.ts
 *         BASE_URL=... EXPECT_COMMIT=<sha> npx tsx scripts/slo-check.ts
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '')
const EXPECT_COMMIT = process.env.EXPECT_COMMIT

/** Discarded. A cold server compiles and opens its first pool connection on
 *  request one; holding a deploy for that fails every run for a reason no user
 *  ever experiences. */
const WARMUP = 3
const SAMPLES = 20

interface Budget {
  path: string
  label: string
  p95Ms: number
  p99Ms: number
}

/**
 * Two profiles, because one set of numbers cannot serve both places this runs.
 *
 * The gate measures a Node server and a Postgres on the same machine; production
 * measures a serverless function reaching a hosted database across a network,
 * with a cold start in the mix. A budget loose enough for production is roughly
 * a hundred times the local figure, and a gate whose budget can never be
 * breached is decoration — it would report PASS through a tenfold regression.
 *
 * The local budgets still carry a lot of headroom over what a warm laptop
 * measures (single-digit milliseconds), because a loaded CI runner is not a
 * warm laptop, and a latency check that fails on a busy runner teaches people
 * to re-run it until it goes green.
 */
type Profile = 'local' | 'production'

const PROFILE: Profile = (process.env.SLO_PROFILE as Profile | undefined)
  // Anything not localhost is a real deployment across a network.
  ?? (/localhost|127\.0\.0\.1/.test(process.env.BASE_URL ?? '') ? 'local' : 'production')

const BUDGETS: Record<Profile, Budget[]> = {
  local: [
    { path: '/api/health', label: 'health probe', p95Ms: 300, p99Ms: 600 },
    { path: '/', label: 'marketing page', p95Ms: 800, p99Ms: 1200 },
    { path: '/login', label: 'login page', p95Ms: 800, p99Ms: 1200 },
  ],
  production: [
    { path: '/api/health', label: 'health probe', p95Ms: 500, p99Ms: 1000 },
    { path: '/', label: 'marketing page', p95Ms: 1500, p99Ms: 2500 },
    { path: '/login', label: 'login page', p95Ms: 1500, p99Ms: 2500 },
  ],
}

const failures: string[] = []
const serverErrors: string[] = []

/**
 * Nearest-rank percentile: the smallest sample at or above the given rank.
 *
 * NOT interpolated. With 20 samples an interpolated p99 is a weighted average
 * of the two slowest, which invents a number that was never measured; the rank
 * method reports a request that actually happened.
 */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(rank, sorted.length) - 1]!
}

async function timedGet(path: string): Promise<{ ms: number; status: number; body: string }> {
  const startedAt = performance.now()
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'user-agent': 'medroster-slo-check' },
    // No keep-alive reuse games and no caching — measure what a fresh caller
    // gets, which is what the objective is about.
    cache: 'no-store',
  })
  const body = await res.text()
  return { ms: performance.now() - startedAt, status: res.status, body }
}

async function measure(budget: Budget): Promise<void> {
  for (let i = 0; i < WARMUP; i++) await timedGet(budget.path)

  const samples: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const { ms, status } = await timedGet(budget.path)
    samples.push(ms)
    // SLI 3: any 5xx fails outright, however fast it was returned. A fast 500
    // is not a pass.
    if (status >= 500) serverErrors.push(`${budget.path} returned ${status}`)
    else if (status >= 400) failures.push(`${budget.path} returned ${status} — expected a success`)
  }

  samples.sort((a, b) => a - b)
  const p95 = percentile(samples, 95)
  const p99 = percentile(samples, 99)
  const round = (n: number) => Math.round(n)

  const verdict = p95 <= budget.p95Ms && p99 <= budget.p99Ms ? 'PASS' : 'FAIL'
  console.log(
    `${verdict}  ${budget.label.padEnd(16)} ${budget.path.padEnd(14)} ` +
    `p50=${round(percentile(samples, 50))}ms  ` +
    `p95=${round(p95)}ms (budget ${budget.p95Ms})  ` +
    `p99=${round(p99)}ms (budget ${budget.p99Ms})`,
  )

  if (p95 > budget.p95Ms) {
    failures.push(
      `${budget.path} p95 was ${round(p95)}ms, over its ${budget.p95Ms}ms budget ` +
      `by ${round(p95 - budget.p95Ms)}ms`,
    )
  }
  if (p99 > budget.p99Ms) {
    failures.push(
      `${budget.path} p99 was ${round(p99)}ms, over its ${budget.p99Ms}ms budget ` +
      `by ${round(p99 - budget.p99Ms)}ms`,
    )
  }
}

/** SLI 1 and SLI 4. */
async function checkHealth(): Promise<void> {
  const { status, body } = await timedGet('/api/health')

  if (status !== 200) {
    failures.push(`health probe returned ${status} — the instance is not ready to serve`)
    return
  }

  let parsed: { status?: string; database?: string; commit?: string }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    failures.push(`health probe returned 200 but its body was not JSON: ${body.slice(0, 120)}`)
    return
  }

  console.log(`PASS  availability     /api/health    status=${parsed.status} database=${parsed.database} commit=${parsed.commit}`)

  if (parsed.status !== 'ok') failures.push(`health probe reported status="${parsed.status}"`)
  if (parsed.database !== 'ok') failures.push(`health probe reported database="${parsed.database}"`)

  // SLI 4 — only meaningful when the caller says which build it expects, so a
  // local run without EXPECT_COMMIT skips it rather than inventing a pass.
  if (EXPECT_COMMIT) {
    const expected = EXPECT_COMMIT.slice(0, 7)
    if (parsed.commit !== expected) {
      failures.push(
        `deploy integrity: the live instance reports commit "${parsed.commit}" but this run ` +
        `built "${expected}". The pipeline was green for an artefact that is not the one serving.`,
      )
    } else {
      console.log(`PASS  deploy integrity /api/health    live commit ${parsed.commit} matches this build`)
    }
  }
}

async function main(): Promise<void> {
  console.log(`SLO check against ${BASE_URL}`)
  console.log(`profile: ${PROFILE} · ${WARMUP} warm-up requests discarded, ${SAMPLES} measured per route\n`)

  await checkHealth()
  for (const budget of BUDGETS[PROFILE]) await measure(budget)

  if (serverErrors.length > 0) {
    console.error(`\nSLI 3 — error rate. Objective is zero 5xx; saw ${serverErrors.length}:`)
    for (const e of new Set(serverErrors)) console.error(`  - ${e}`)
  }

  if (failures.length > 0 || serverErrors.length > 0) {
    console.error('\nSLO CHECK FAILED')
    for (const f of failures) console.error(`  - ${f}`)
    console.error('\nBudgets and their reasoning: docs/SLO.md')
    process.exit(1)
  }

  console.log('\nAll SLOs met.')
}

main().catch((err: unknown) => {
  // A thrown error here means the instance could not be reached at all, which
  // is the most severe possible answer to "is it healthy?".
  console.error(`\nSLO CHECK FAILED — could not complete against ${BASE_URL}`)
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
