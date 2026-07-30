export interface DemoAccount {
  label: string
  email: string
}

/**
 * Seeded accounts a reviewer can sign in as without leaving this page — the
 * manager plus one staff member per profession. These are real rows produced
 * by `lib/seed/run-seed.ts` from the dirty CSVs (not placeholders), and
 * `lib/seed/auth-accounts.ts` gives each one an actual Supabase login (email
 * confirmed, password set) so it can sign in for real; every account shares
 * `SEED_PASSWORD`. Every other imported staff row is deliberately left
 * without a Supabase login.
 */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { label: 'Manager', email: 'manager@clinicmail.test' },
  { label: 'Doctor', email: 'chloe.hussain@clinicmail.test' },
  { label: 'Nurse', email: 'ivy.bell@clinicmail.test' },
  { label: 'Receptionist', email: 'hiro.petrova@clinicmail.test' },
]
