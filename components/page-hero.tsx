import type { ReactNode } from 'react'
import { RadialGauge } from '@/components/radial-gauge'
import { cn } from '@/lib/utils'

/**
 * The page-hero band every app screen (dashboard, shift detail, import
 * report, ...) opens with: a dark teal gradient, rounded 18px, carrying an
 * eyebrow, a display title, and optionally a radial gauge for that screen's
 * single headline number.
 *
 * App screens never use photography — only the landing page does — because
 * these are dense working tools that must load fast (§design direction).
 */
export function PageHero({
  eyebrow,
  title,
  gauge,
  children,
  className,
}: {
  eyebrow: string
  title: string
  gauge?: { value: number; label: string }
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'hero-gradient flex flex-col gap-6 rounded-[18px] px-6 py-8 text-white sm:flex-row sm:items-center sm:justify-between sm:px-10 sm:py-10',
        className,
      )}
    >
      <div className="space-y-2">
        <p className="font-mono text-xs font-semibold tracking-[0.2em] text-white/70 uppercase">{eyebrow}</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
        {children}
      </div>
      {gauge ? <RadialGauge value={gauge.value} label={gauge.label} className="shrink-0 text-white" /> : null}
    </div>
  )
}
