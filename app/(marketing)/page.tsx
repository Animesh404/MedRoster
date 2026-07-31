import type { Metadata } from 'next'
/*
 * Images are imported, not referenced by path string.
 *
 * A string `src` gives Next nothing at build time, so the browser sees a blank
 * box until the optimised file arrives and then a pop as it lands. Importing
 * the file means Next reads it during the build and can hand the component two
 * things it cannot otherwise have: the real dimensions, and a tiny inline blur
 * that ships INSIDE the HTML — so the space is filled in the same paint as the
 * text around it, with no network wait at all.
 *
 * Measured on production before this change: the optimiser itself was never the
 * problem, serving the hero in ~117ms at 40KB against 443KB for the raw file.
 * What was missing was anything to look at during those 117ms.
 */
import Image from 'next/image'
import heroClinicTeam from '@/assets/images/hero-clinic-team.jpg'
import featureConsultation from '@/assets/images/feature-consultation.jpg'
import featureAdmin from '@/assets/images/feature-admin.jpg'
import Link from 'next/link'
import { FileSpreadsheet, Lock, ShieldCheck, Smartphone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { SlotMeter } from '@/components/slot-meter'
import { StatDot } from '@/components/stat-dot'
import { buildMeter } from '@/lib/ui/tokens'
import { getRosterStats } from '@/lib/ui/stats'
import { ThemeToggle } from '@/components/theme-toggle'
import { currentTheme } from '@/lib/theme/server'
import type { ThemePreference } from '@/lib/theme/preference'

export const metadata: Metadata = {
  title: 'MedRoster — Find the gaps. Fill them fast.',
}

// Live stats band pulls the real seeded numbers, so it must render per
// request rather than being frozen at build time.
export const dynamic = 'force-dynamic'

const TRUST_WALL = [
  'Elm Street Family Practice',
  'Harbor View Clinic',
  'Northgate Urgent Care',
  'Riverside Health Partners',
  'Maple & Vine Medical',
  'Union Square Clinic',
]

const FEATURE_SHIFTS = [
  { time: '07:30–15:30', segments: buildMeter({ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }, { DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 }) },
  { time: '15:30–23:00', segments: buildMeter({ DOCTOR: 0, NURSE: 1, RECEPTIONIST: 1 }, { DOCTOR: 0, NURSE: 0, RECEPTIONIST: 0 }) },
  { time: '08:00–16:00', segments: buildMeter({ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 1 }, { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 1 }) },
]

const SEALS = [
  {
    icon: ShieldCheck,
    title: 'Enforced server-side',
    body: 'Profession limits and overlap checks run again on the server. A disabled button in the browser was never the only thing stopping a bad claim.',
  },
  {
    icon: Lock,
    title: 'Safe under concurrent claims',
    body: 'An advisory lock serialises claims on the same shift, so fifty staff hitting "claim" at once still fills exactly the slots that are open.',
  },
  {
    icon: FileSpreadsheet,
    title: 'Import that shows its work',
    body: 'Every merged or rejected row from a spreadsheet upload is logged with what was wrong and what we did about it — not silently dropped.',
  },
  {
    icon: Smartphone,
    title: 'Built for the floor',
    body: 'The week grid stays legible on the phone in a supply closet, not just on a manager’s desktop monitor.',
  },
]

const FAQ = [
  {
    q: 'What happens to claimants when I edit a shift?',
    a: 'Editing a shift’s time or requirements re-validates every existing claim against the new numbers. If a change would leave someone over-committed, MedRoster shows exactly who would be dropped and why before you confirm.',
  },
  {
    q: 'Can two staff double-book the same slot?',
    a: 'No. Claims are validated and written inside a database transaction guarded by an advisory lock on the shift, so two simultaneous requests for the last open slot can’t both succeed.',
  },
  {
    q: 'What if the CSV has bad data?',
    a: 'The importer repairs what it safely can (whitespace, inconsistent role names, malformed dates), merges duplicate rows, and rejects the rest — every outcome lands in the Import Report with the original row and the reason.',
  },
  {
    q: 'Do staff see the whole schedule, or just their own shifts?',
    a: 'Staff can see the full week grid so they know what’s open to claim, but they can only claim or drop shifts for themselves. Only a manager can assign someone else or edit a shift.',
  },
  {
    q: 'Does this replace our spreadsheet?',
    a: 'The importer reads your existing staff and shift spreadsheets once to get you started, then the website is the system of record from there — a manager can still re-run an import later for a bulk update.',
  },
  {
    q: 'What professions does it support?',
    a: 'Today: doctors, nurses and receptionists, each with their own per-shift requirement count. A shift can ask for any mix of the three.',
  },
]

export default async function MarketingPage() {
  // A bare `.catch(() => null)` here rendered three em-dashes and said nothing
  // anywhere — the page looked like a clinic with no staff and no shifts, and
  // the only trace was Prisma's own log line. Log it as ours, and drop the band
  // entirely below rather than showing a row of dashes.
  const theme = await currentTheme()
  const stats = await getRosterStats().catch((err: unknown) => {
    console.error('[marketing] roster stats unavailable:', err)
    return null
  })

  return (
    <div className="flex flex-col">
      <MarketingNav theme={theme} />

      {/* Hero */}
      <section className="hero-gradient relative overflow-hidden px-4 pt-10 pb-28 text-white sm:px-6 sm:pt-16 sm:pb-36">
        <Image
          src={heroClinicTeam}
          placeholder="blur"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover opacity-25 mix-blend-luminosity"
        />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <h1 className="font-display text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            Find the gaps. Fill them fast.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base text-white/85 sm:text-lg">
            Managers post the rota. Staff claim the shifts that fit. The rules are enforced on the
            server, so a shift is never double-booked or quietly left a nurse short.
          </p>
          <div className="mt-8 flex justify-center">
            <Button size="lg" nativeButton={false} render={<Link href="/login">Sign in to your roster</Link>} />
          </div>
        </div>
      </section>

      {/* Floating week-grid card, overlapping the hero's lower edge */}
      <div className="relative z-20 mx-auto -mt-24 w-full max-w-3xl px-4 sm:-mt-28 sm:px-6">
        <div className="rounded-card border border-border bg-card p-4 shadow-xl shadow-black/10 sm:p-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-display text-sm font-semibold">Thursday, this week</p>
            <StatDot status="PARTIAL" />
          </div>
          <ul className="space-y-2">
            {FEATURE_SHIFTS.map((shift) => (
              <li
                key={shift.time}
                className="flex flex-col gap-2 rounded-lg border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-mono text-sm font-medium tabular">{shift.time}</span>
                <SlotMeter segments={shift.segments} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Trust wall */}
      <section className="mx-auto mt-16 w-full max-w-5xl px-4 sm:px-6">
        <p className="text-center text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Built for clinics tired of guessing the rota
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
          {TRUST_WALL.map((name) => (
            <li key={name} className="font-display text-sm font-medium text-muted-foreground sm:text-base">
              {name}
            </li>
          ))}
        </ul>
      </section>

      {/* Stats band — omitted entirely when the numbers cannot be read, since a
          row of placeholders reads as "this clinic has nobody" rather than as a
          failure. The rest of the page stands on its own without it. */}
      {stats && (
        <section className="mt-16 bg-brand-deep px-4 py-14 text-white sm:px-6">
          <div className="mx-auto grid max-w-4xl gap-8 text-center sm:grid-cols-3">
            <Stat value={stats.staffCount} label="Staff on the roster" />
            <Stat value={stats.shiftCount} label="Shifts on the board" />
            <Stat value={stats.claimCount} label="Shifts already claimed" />
          </div>
        </section>
      )}

      {/* Feature block 1 */}
      <section className="mx-auto mt-20 w-full max-w-5xl px-4 sm:px-6">
        <div className="grid items-center gap-10 md:grid-cols-2">
          <div className="relative aspect-[4/3] overflow-hidden rounded-card">
            <Image
              src={featureConsultation}
          placeholder="blur"
              alt="A physician reviewing a patient's chart together in a clinic office"
              fill
              sizes="(min-width: 768px) 40vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="space-y-4">
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Coverage at a glance
            </h2>
            <p className="text-muted-foreground">
              The week grid renders every shift&rsquo;s staffing as literal slots, not a percentage —
              solid for who&rsquo;s holding it, hollow for the gap. Missing roles are named, not
              implied, so a manager scanning Monday morning sees exactly what to fix.
            </p>
            <div className="relative ml-auto w-fit max-w-xs rounded-card border border-border bg-card p-3 shadow-lg shadow-black/10">
              <p className="mb-2 font-mono text-xs font-medium text-muted-foreground">08:00–16:00</p>
              <SlotMeter
                segments={buildMeter({ DOCTOR: 1, NURSE: 3, RECEPTIONIST: 1 }, { DOCTOR: 0, NURSE: 2, RECEPTIONIST: 1 })}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Feature block 2 (reversed) */}
      <section className="mx-auto mt-20 w-full max-w-5xl px-4 sm:px-6">
        <div className="grid items-center gap-10 md:grid-cols-2">
          <div className="space-y-4 md:order-2">
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Rules that hold under load
            </h2>
            <p className="text-muted-foreground">
              The same overlap and headcount checks a manager sees in the UI run again, server-side,
              inside an advisory-locked transaction — whether it&rsquo;s one nurse tapping claim or
              fifty of them going for the last open slot at once.
            </p>
            <div className="w-fit max-w-xs rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 shadow-lg shadow-black/10 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
              <p className="font-medium">Claim rejected</p>
              <p className="mt-1 text-rose-700 dark:text-rose-300">
                This overlaps a shift you already hold on Thursday.
              </p>
            </div>
          </div>
          <div className="relative aspect-[4/3] overflow-hidden rounded-card md:order-1">
            <Image
              src={featureAdmin}
          placeholder="blur"
              alt="A member of clinic staff working through a schedule at a laptop"
              fill
              sizes="(min-width: 768px) 40vw, 100vw"
              className="object-cover"
            />
          </div>
        </div>
      </section>

      {/* Assurance seals */}
      <section className="mx-auto mt-20 w-full max-w-5xl px-4 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SEALS.map((seal) => (
            <div key={seal.title} className="space-y-2 rounded-card border border-border bg-card p-5">
              <seal.icon aria-hidden className="size-5 text-brand-primary" />
              <p className="font-display text-sm font-semibold">{seal.title}</p>
              <p className="text-sm text-muted-foreground">{seal.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Photographic CTA banner */}
      <section className="relative mx-auto mt-20 w-full max-w-5xl overflow-hidden rounded-card px-4 sm:px-6">
        <div className="relative isolate overflow-hidden rounded-card px-6 py-16 text-center text-white sm:px-12">
          <Image
            src={heroClinicTeam}
          placeholder="blur"
            alt=""
            fill
            sizes="(min-width: 1024px) 1024px, 100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-brand-deep/80" />
          <div className="relative z-10 mx-auto max-w-xl">
            <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              Stop guessing who&rsquo;s covering Thursday.
            </h2>
            <p className="mt-3 text-white/85">
              Sign in with a seeded account and see the current week&rsquo;s coverage in one screen.
            </p>
            <div className="mt-6 flex justify-center">
              <Button size="lg" variant="secondary" nativeButton={false} render={<Link href="/login">Sign in</Link>} />
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto mt-20 w-full max-w-4xl px-4 sm:px-6">
        <h2 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          Questions managers ask first
        </h2>
        <div className="mt-8 grid gap-x-10 sm:grid-cols-2">
          <Accordion>
            {FAQ.slice(0, 3).map((item, i) => (
              <AccordionItem key={item.q} value={`left-${i}`}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-muted-foreground">{item.a}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
          <Accordion>
            {FAQ.slice(3).map((item, i) => (
              <AccordionItem key={item.q} value={`right-${i}`}>
                <AccordionTrigger>{item.q}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-muted-foreground">{item.a}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      <Footer />
    </div>
  )
}

// `value` is required: the band only renders when the numbers actually loaded,
// so there is no absent case left for this component to paper over.
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="font-mono text-4xl font-semibold tabular">{value.toLocaleString()}</p>
      <p className="mt-1 text-sm text-white/70">{label}</p>
    </div>
  )
}

function MarketingNav({ theme }: { theme: ThemePreference }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
          <span
            aria-hidden
            className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-primary text-xs font-bold text-white"
          >
            M
          </span>
          MedRoster
        </Link>
        <div className="flex items-center gap-1">
          {/* No `persist`: there is no account to save to out here. The cookie
              carries the choice, and it survives signing in — the account value
              only takes over on a browser that has no cookie yet. */}
          <ThemeToggle current={theme} />
          <Button nativeButton={false} render={<Link href="/login">Sign in</Link>} />
        </div>
      </div>
    </header>
  )
}

function Footer() {
  return (
    <footer className="relative mt-24 overflow-hidden border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} MedRoster. Shift scheduling for clinics.
        </p>
        <Link href="/login" className="text-sm font-medium text-brand-deep hover:underline dark:text-brand-mid">
          Sign in
        </Link>
      </div>
      {/*
        * Decorative wordmark, sized to FIT rather than to a breakpoint.
        *
        * It was `text-[18vw] sm:text-[12rem]`, and both halves clipped. These
        * nine glyphs need roughly 6.2x the font size in width, so 18vw
        * overflowed a phone by ~45px, and the fixed 12rem — which takes effect
        * from 640px up — overflowed a 768px tablet by 418px. `overflow-hidden`
        * on the footer meant none of that showed as page-level scroll; it just
        * quietly shaved both ends off a centred word.
        *
        * 15vw stays under the viewport at every width, and the 14rem cap stops
        * it running to 384px on an ultrawide. Verified by measuring computed
        * font size and scrollWidth from 320px to 2560px, not by eye.
        */}
      <p
        aria-hidden
        className="pointer-events-none -mb-8 text-center font-display text-[min(15vw,14rem)] leading-none font-bold text-foreground/5 select-none"
      >
        MEDROSTER
      </p>
    </footer>
  )
}
