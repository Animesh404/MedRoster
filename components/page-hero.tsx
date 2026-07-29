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
  /** `className` lets a screen recolour the gauge for its own headline
   *  status (e.g. the shift detail page turns it amber while partly
   *  staffed) — defaults to the plain white every other hero uses, so
   *  existing call sites are unaffected. */
  gauge?: { value: number; label: string; className?: string }
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
      {gauge ? (
        <>
          {/*
           * Two sizes, toggled purely by CSS display (§responsiveness: "the
           * gauge shrinks" below 768px) rather than one instance resized via
           * inline style — RadialGauge's stroke width and centred percentage
           * are computed from its numeric `size` prop, so a single instance
           * can't be responsively resized by a parent media query alone.
           * `display: none` removes the hidden one from the accessibility
           * tree, so this never doubles up for assistive tech.
           */}
          <div className="shrink-0 md:hidden">
            <RadialGauge value={gauge.value} label={gauge.label} size={64} className={gauge.className ?? 'text-white'} />
          </div>
          <div className="hidden shrink-0 md:block">
            <RadialGauge value={gauge.value} label={gauge.label} size={96} className={gauge.className ?? 'text-white'} />
          </div>
        </>
      ) : null}
    </div>
  )
}
