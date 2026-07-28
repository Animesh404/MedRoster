export interface DemoAccount {
  label: string
  email: string
}

/**
 * Seeded accounts a reviewer can sign in as without leaving this page — the
 * manager plus one staff member per profession. These are real rows produced
 * by `lib/seed/run-seed.ts` from the dirty CSVs (not placeholders); every
 * account shares `SEED_PASSWORD`.
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { label: 'Manager', email: 'manager@clinicmail.test' },
  { label: 'Doctor', email: 'chloe.hussain@clinicmail.test' },
  { label: 'Nurse', email: 'ivy.bell@clinicmail.test' },
  { label: 'Receptionist', email: 'hiro.petrova@clinicmail.test' },
]
