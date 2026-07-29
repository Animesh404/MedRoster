'use client'

import { Button } from '@/components/ui/button'
import { useOptimisticClaim } from '@/hooks/use-optimistic-claim'
import { useRegisterMutation } from '@/components/realtime/week-realtime-sync'

/**
 * Optimistic claim/release (§8.3). The state flips before the request lands
 * and rolls back on rejection, showing the SERVER's message — the same
 * string the validator produced. Surfacing it verbatim is what demonstrates
 * the rule is enforced server-side rather than guessed at in the client.
 */
export function ClaimButton({ shiftId, claimed, userId }: {
  shiftId: number
  claimed: boolean
  userId: number
}) {
  const registerMutation = useRegisterMutation()
  const { claimed: optimistic, pending, error, claim, release } = useOptimisticClaim(shiftId, {
    claimed, userId, onMutationStart: registerMutation,
  })

  return (
    <div className="space-y-2">
      <Button
        onClick={optimistic ? release : claim}
        disabled={pending}
        variant={optimistic ? 'outline' : 'default'}
        className={error ? 'claim-rollback-shake' : 'slot-fill-transition'}
      >
        {optimistic ? 'Release shift' : 'Claim shift'}
      </Button>

      {error && (
        <p
          role="alert"
          className="claim-rollback-message rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        >
          {error}
        </p>
      )}
    </div>
  )
}
