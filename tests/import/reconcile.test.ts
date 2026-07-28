import { describe, expect, it } from 'vitest'
import { runShiftImport, runStaffImport } from '@/lib/import'

const S = 'staff_id,full_name,role,email\n'
const H = 'shift_id,date,start_time,end_time,requirements\n'

describe('staff reconciliation', () => {
  it('merges a byte-identical duplicate row', () => {
    const r = runStaffImport(S +
      '103,Marcus Kapoor,receptionist,marcus.kapoor@clinicmail.test\n' +
      '103,Marcus Kapoor,receptionist,marcus.kapoor@clinicmail.test\n')
    expect(r.stats).toMatchObject({ accepted: 1, merged: 1, rejected: 0, total: 2 })
    expect(r.rows[1]!.outcome).toBe('MERGED')
  })

  it('merges the same person filed under two ids, keeping the lowest', () => {
    const r = runStaffImport(S +
      '999,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n' +
      '105,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.externalId).toBe(105)
    expect(r.rows.find((x) => x.outcome === 'MERGED')!.mergedIntoExternalId).toBe(105)
  })

  it('rejects a second person reusing an existing email', () => {
    const r = runStaffImport(S +
      '107,Hiro Iyer,Receptionist,hiro.iyer@clinicmail.test\n' +
      '998,J. Placeholder,Nurse,hiro.iyer@clinicmail.test\n')
    expect(r.stats).toMatchObject({ accepted: 1, rejected: 1 })
    expect(r.rows[1]!.issues.map((i) => i.code)).toContain('EMAIL_COLLISION')
  })

  it('keeps the first row when one id carries conflicting data', () => {
    const r = runStaffImport(S +
      '150,Ann Lee,Nurse,ann.lee@c.test\n' +
      '150,Ann Lee,Doctor,ann2.lee@c.test\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.profession).toBe('NURSE')
    expect(r.rows[1]!.outcome).toBe('MERGED')
    expect(r.rows[1]!.issues.map((i) => i.code)).toContain('DUPLICATE_ID_CONFLICT')
  })

  it('a third row reusing an already-merged-away id resolves to the surviving record, not a fresh one', () => {
    // Regression for the "silent un-merge" bug: `index` used to be populated
    // only when a row was first ACCEPTED, never when a later row MERGED into
    // it. So a genuine triple duplicate — id 105 (lowest, survives), then id
    // 999 filed with the identical email (merges into 105 via the email key,
    // as already covered above) — left 999's OWN id key unindexed. A THIRD
    // row also claiming id 999, but with a typo'd email that no longer
    // matches 105's email, found nothing in `index` and was accepted afresh
    // as a brand-new record under id 999, un-merging what should have stayed
    // folded into 105.
    const r = runStaffImport(S +
      '105,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n' +
      '999,Zainab Volkov,NURSE,zainab.volkov@clinicmail.test\n' +
      '999,Zainab Volkov,NURSE,zainab.vollkov@clinicmail.test\n')

    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.externalId).toBe(105)
    expect(r.stats).toMatchObject({ accepted: 1, merged: 2, rejected: 0, total: 3 })

    const merged = r.rows.filter((row) => row.outcome === 'MERGED')
    expect(merged).toHaveLength(2)
    for (const row of merged) {
      expect(row.mergedIntoExternalId).toBe(105)
      expect(row.record).toBeNull()
    }
  })
})

describe('shift reconciliation', () => {
  it('merges a byte-identical duplicate row', () => {
    const r = runShiftImport(H +
      '5020,2026-08-08,22:00,06:00,nurses=1;doctors=0;receptionists=0\n' +
      '5020,2026-08-08,22:00,06:00,nurses=1;doctors=0;receptionists=0\n')
    expect(r.stats).toMatchObject({ accepted: 1, merged: 1, total: 2 })
  })

  it('merges two ids that share date, time AND requirements', () => {
    const r = runShiftImport(H +
      '5053,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1\n' +
      '5054,2026-08-17,08:00,16:00,nurses=3;doctors=1;receptionists=1\n')
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0]!.externalId).toBe(5053)
  })

  it('does NOT merge same-slot shifts with different requirements', () => {
    // The 24-group trap from §2.2 — merging these would delete real shifts.
    const r = runShiftImport(H +
      '5003,2026-08-04,08:00,16:00,nurses=3;doctors=2;receptionists=0\n' +
      '5004,2026-08-04,08:00,16:00,nurses=1;doctors=2;receptionists=0\n' +
      '5005,2026-08-04,08:00,16:00,nurses=2;doctors=0;receptionists=0\n')
    expect(r.accepted).toHaveLength(3)
    expect(r.stats.merged).toBe(0)
  })
})
