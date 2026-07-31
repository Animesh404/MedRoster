import type { Metadata } from 'next'
import Image from 'next/image'
import heroClinicTeam from '@/assets/images/hero-clinic-team.jpg'
import Link from 'next/link'
import { getRosterStats } from '@/lib/ui/stats'
import { LoginForm } from './login-form'
import { ThemeToggle } from '@/components/theme-toggle'
import { currentTheme } from '@/lib/theme/server'

// Live counts (below) come straight from the database, so this route must
// stay dynamic — a static build would freeze them at build time.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign in — MedRoster',
}

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'medroster123'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams
  // Aggregate counts only — nothing sensitive — so a failed connection just
  // hides the numbers rather than taking the whole sign-in page down.
  const stats = await getRosterStats().catch(() => null)
  const theme = await currentTheme()

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hero-gradient relative hidden flex-col justify-between overflow-hidden p-10 text-white lg:flex">
        <Image
          src={heroClinicTeam}
          placeholder="blur"
          alt=""
          fill
          priority
          sizes="50vw"
          className="object-cover opacity-20 mix-blend-luminosity"
        />
        <div className="relative z-10 space-y-4">
          <Link href="/" className="font-display text-lg font-semibold">
            MedRoster
          </Link>
          <h1 className="font-display max-w-md text-3xl font-semibold tracking-tight text-balance">
            Find the gaps. Fill them fast.
          </h1>
          <p className="max-w-md text-white/80">
            Managers post the rota. Staff claim the shifts that fit. The rules are enforced on the
            server, so a shift is never double-booked or quietly left a nurse short.
          </p>
        </div>
        {stats ? (
          <dl className="relative z-10 grid grid-cols-3 gap-4">
            <div>
              <dt className="text-xs tracking-wide text-white/60 uppercase">Staff</dt>
              <dd className="font-mono text-2xl font-semibold tabular">{stats.staffCount}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-white/60 uppercase">Shifts</dt>
              <dd className="font-mono text-2xl font-semibold tabular">{stats.shiftCount}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-white/60 uppercase">Claimed</dt>
              <dd className="font-mono text-2xl font-semibold tabular">{stats.claimCount}</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <div className="relative flex items-center justify-center p-6 sm:p-10">
        {/* Top-right of the form column, so it is reachable on the narrow
            layout too — the photo panel beside it is hidden below `lg`, and a
            toggle only in there would vanish on exactly the screens where a
            dark interface matters most. */}
        <div className="absolute top-4 right-4">
          <ThemeToggle current={theme} />
        </div>
        <div className="w-full max-w-sm space-y-8">
          <Link href="/" className="font-display text-lg font-semibold text-brand-deep lg:hidden dark:text-brand-mid">
            MedRoster
          </Link>
          <div className="space-y-1">
            <h2 className="font-display text-2xl font-semibold">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Use your MedRoster account, or a demo login below.
            </p>
          </div>
          <LoginForm next={next ?? ''} demoPassword={SEED_PASSWORD} error={error} />
        </div>
      </div>
    </div>
  )
}
