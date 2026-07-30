// Loaded here, not assumed already loaded: `prisma db seed` / `prisma migrate
// reset` run this file as a child process that inherits whatever the Prisma
// CLI already put in `process.env` (via `prisma.config.ts`'s own `dotenv/config`
// import), but `npm run db:seed` invokes `tsx prisma/seed.ts` directly with no
// Prisma CLI in front of it — nothing has loaded `.env` in that case, and
// `lib/db/client.ts` then fails with "DATABASE_URL_DEV must be set" even
// though `.env` sets it right there on disk.
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { createClient } from '@supabase/supabase-js'
import { prisma } from '@/lib/db/client'
import { runSeed } from '@/lib/seed/run-seed'
import { getClientEnv, getServerEnv } from '@/lib/config/env'
import { ensureAuthAccounts, type AuthAdminPort } from '@/lib/seed/auth-accounts'

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

  // Built inline rather than via `@/lib/supabase/admin` (`createSupabaseAdminClient`):
  // that module opens with `import 'server-only'`, which throws unconditionally
  // outside a bundler-mediated React Server Component resolution — and this
  // script runs as a plain Node/tsx process, including as the command Prisma
  // 7 invokes for `npx prisma db seed` / `migrate reset` (see
  // `prisma.config.ts`'s `migrations.seed`). Importing the guarded module
  // here broke every one of those. Do not "helpfully" swap this back for
  // `createSupabaseAdminClient()` — six duplicated lines of client
  // construction here are cheaper than re-breaking `prisma db seed`, and
  // cheaper than a `--conditions=react-server` override, which changes
  // module resolution for every package in this process, not just this one.
  const supabaseAdmin = createClient(
    getClientEnv().supabaseUrl,
    getServerEnv().supabaseServiceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ).auth.admin

  // Adapted explicitly rather than passed straight through: supabase-js types
  // `listUsers()` as returning a union whose members carry extra fields, which
  // is wider than AuthAdminPort and will not assign structurally. Writing the
  // three calls out keeps the port honest without an `as unknown as` cast that
  // would silently survive a breaking change in supabase-js.
  const adminPort: AuthAdminPort = {
    listUsers: async () => {
      const { data, error } = await supabaseAdmin.listUsers({ perPage: 1000 })
      return { data: { users: data?.users ?? [] }, error }
    },
    createUser: async (attrs) => {
      const { data, error } = await supabaseAdmin.createUser(attrs)
      return { data: { user: data?.user ?? null }, error }
    },
    updateUserById: async (id, attrs) => {
      const { data, error } = await supabaseAdmin.updateUserById(id, attrs)
      return { data: { user: data?.user ?? null }, error }
    },
  }

  const accounts = await ensureAuthAccounts(prisma, adminPort, { password: SEED_PASSWORD })
  console.log(`auth    ${accounts.created} created, ${accounts.updated} updated`)
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
