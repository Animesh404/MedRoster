import { readFileSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db/client'
import { runShiftImport, runStaffImport } from '@/lib/import'
import { applyShiftImport, applyStaffImport } from '@/lib/import/apply'
import { seedClaims } from '@/lib/seed/claim-seeder'

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10)

  // Idempotent: upserts keyed on the CSV ids mean re-running never duplicates.
  await prisma.user.upsert({
    where: { email: 'manager@clinicmail.test' },
    create: {
      email: 'manager@clinicmail.test', name: 'Dana Okonkwo',
      passwordHash, role: 'MANAGER',
    },
    update: { passwordHash },
  })

  const staffResult = runStaffImport(readFileSync('staff.csv', 'utf8'))
  await prisma.$transaction((tx) =>
    applyStaffImport(tx, staffResult, {
      source: 'SEED', filename: 'staff.csv', passwordHash,
    }), { timeout: 60_000 })

  const shiftResult = runShiftImport(readFileSync('shifts.csv', 'utf8'))
  await prisma.$transaction((tx) =>
    applyShiftImport(tx, shiftResult, {
      source: 'SEED', filename: 'shifts.csv', passwordHash,
    }), { timeout: 120_000 })

  console.log('staff  ', staffResult.stats)
  console.log('shifts ', shiftResult.stats)

  const existingClaims = await prisma.claim.count()
  if (existingClaims === 0) {
    const { attempted, created } = await seedClaims(prisma, { seed: 1337, fillRatio: 0.55 })
    console.log(`claims  attempted ${attempted}, created ${created}`)
  } else {
    console.log(`claims  ${existingClaims} already present, skipping claim seeding`)
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
