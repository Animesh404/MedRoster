import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decodeWeek, encodeWeek, type WeekView } from '@/lib/contracts/week'
import { computeCoverage } from '@/lib/coverage'
import { assignClaim } from '@/lib/rules/assign'
import { getTestDb, resetTestDb, stopTestDb } from '../helpers/db'

beforeEach(resetTestDb)
afterAll(stopTestDb)

describe('week coverage over real data', () => {
  it('reports which roles are still missing after a partial claim', async () => {
    const db = await getTestDb()
    const shift = await db.shift.create({
      data: {
        startsAt: new Date('2026-12-01T09:00Z'), endsAt: new Date('2026-12-01T17:00Z'),
        requirements: { create: [
          { profession: 'NURSE', requiredCount: 2 },
          { profession: 'DOCTOR', requiredCount: 1 },
          { profession: 'RECEPTIONIST', requiredCount: 0 },
        ] },
      },
    })
    const nurse = await db.user.create({
      data: { email: 'n@c.test', name: 'N', role: 'STAFF', profession: 'NURSE' },
    })
    await assignClaim({ db, shiftId: shift.id, userId: nurse.id, actorId: nurse.id })

    const claims = { DOCTOR: 0, NURSE: 1, RECEPTIONIST: 0 }
    const coverage = computeCoverage({ DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 }, claims)

    expect(coverage.status).toBe('PARTIAL')
    expect(coverage.missing).toEqual({ DOCTOR: 1, NURSE: 1, RECEPTIONIST: 0 })
  })

  it('survives an encode/decode round trip with real claim data', async () => {
    const view: WeekView = {
      isoWeek: '2026-W49',
      staff: [{ id: 1, name: 'N', profession: 'NURSE' }],
      shifts: [{
        id: 1, version: 0,
        startsAt: '2026-12-01T09:00:00.000Z', endsAt: '2026-12-01T17:00:00.000Z',
        requirements: { DOCTOR: 1, NURSE: 2, RECEPTIONIST: 0 },
        claimantIds: [1],
      }],
    }
    expect(decodeWeek(encodeWeek(view))).toEqual(view)
  })
})
