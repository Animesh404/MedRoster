import { parseStaffRows, type StaffRecord } from './staff'
import { parseShiftRows, type ShiftRecord } from './shifts'
import { reconcileShifts, reconcileStaff, type ImportResult } from './reconcile'

export type { ImportResult, ImportedRow } from './reconcile'
export type { StaffRecord } from './staff'
export type { ShiftRecord } from './shifts'

export function runStaffImport(text: string): ImportResult<StaffRecord> {
  return reconcileStaff(parseStaffRows(text))
}

export function runShiftImport(text: string): ImportResult<ShiftRecord> {
  return reconcileShifts(parseShiftRows(text))
}
