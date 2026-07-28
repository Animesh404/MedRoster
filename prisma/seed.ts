import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { runSeed } from '@/lib/seed/run-seed'

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10)
  const result = await runSeed(prisma, { passwordHash })

  console.log('staff  ', result.staffStats)
  console.log('shifts ', result.shiftStats)
  if (result.existingClaims === 0) {
    console.log(`claims  attempted ${result.claimsAttempted}, created ${result.claimsCreated}`)
  } else {
    console.log(`claims  ${result.existingClaims} already present, skipping claim seeding`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
