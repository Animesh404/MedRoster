import { cn } from '@/lib/utils'

/**
 * A single-number gauge rendered as inline SVG (`stroke-dasharray` on a
 * circle) — no chart library. Used by `<PageHero>` for the one headline
 * metric a screen wants to lead with (e.g. this week's fill rate).
 */
export function RadialGauge({
  value,
  label,
  size = 96,
  className,
}: {
  /** 0..1 */
  value: number
  label: string
  size?: number
  className?: string
}) {
  const clamped = Math.max(0, Math.min(1, value))
  const stroke = Math.round(size * 0.09)
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dash = circumference * clamped

  return (
    <div
      role="img"
      aria-label={label}
      className={cn('relative inline-grid place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
        />
      </svg>
      <div aria-hidden className="absolute inset-0 grid place-items-center font-mono text-lg font-semibold tabular">
        {Math.round(clamped * 100)}%
      </div>
    </div>
  )
}
