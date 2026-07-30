import { notFound } from 'next/navigation'
import { currentSessionUser } from '@/lib/auth/session'
import { PageHero } from '@/components/page-hero'
import { NewShiftForm } from '@/components/shift/new-shift-form'
import { can, type Principal } from '@/lib/auth/permissions'

export default async function NewShiftPage() {
  const session = await currentSessionUser()
  if (!session) notFound() // middleware already guards this route
  const principal: Principal = session.principal

  // Defence in depth (§app/(app)/layout.tsx): the nav already hides "New
  // shift" from staff (`can`, same catalogue the API enforces), but a typed
  // URL must not reach a manager-only form either — a staff member never
  // sees a manager-only action, not even by navigating there directly.
  if (!can(principal, 'shift:create')) notFound()

  return (
    <div className="space-y-8">
      <PageHero eyebrow="Scheduling" title="New shift">
        <p className="max-w-prose text-white/85">
          Set the time and headcount, optionally repeat it on a weekly pattern, and see exactly
          what will be created before you commit.
        </p>
      </PageHero>

      <NewShiftForm />
    </div>
  )
}
