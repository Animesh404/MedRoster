// Loaded here for the same reason prisma/seed.ts does: run directly via `tsx`,
// nothing has read `.env` yet and `lib/db/client.ts` fails on a missing
// DATABASE_URL_DEV even though it is sitting there on disk.
import 'dotenv/config'
import { prisma } from '@/lib/db/client'
import { MUTATION_RETENTION_MS, pruneMutationOutcomes } from '@/lib/rules/retention'

/**
 * Manual runner for the retention job — `npm run db:prune`.
 *
 * Production runs this on a schedule via `/api/cron/prune` (see vercel.json).
 * This exists for a local database, a one-off after a load test, or any
 * deployment that is not on Vercel and needs its own cron to call something.
 */
async function main(): Promise<void> {
  const hours = Math.round(MUTATION_RETENTION_MS / 3_600_000)
  const { deleted, exhausted } = await pruneMutationOutcomes(prisma)
  console.log(`pruned ${deleted} mutation outcome(s) older than ${hours}h`)
  if (exhausted) {
    console.warn('hit the batch ceiling — run again, a backlog remains')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
