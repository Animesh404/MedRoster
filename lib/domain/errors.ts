export type RuleCode =
  | 'SHIFT_IN_PAST'
  | 'PROFESSION_NOT_REQUIRED'
  | 'ROLE_FULL'
  | 'OVERLAP'
  | 'ALREADY_CLAIMED'
  | 'NOT_CLAIMED'
  | 'VERSION_CONFLICT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'BUSY'

export interface AppError {
  readonly code: RuleCode
  readonly message: string
  readonly meta?: Record<string, unknown>
}

/** Factory for the domain error catalog — the one place an AppError is constructed. */
export function createAppError(
  code: RuleCode,
  message: string,
  meta?: Record<string, unknown>,
): AppError {
  return meta === undefined ? { code, message } : { code, message, meta }
}

const HTTP_STATUS: Record<RuleCode, number> = {
  SHIFT_IN_PAST: 409, PROFESSION_NOT_REQUIRED: 409, ROLE_FULL: 409,
  OVERLAP: 409, ALREADY_CLAIMED: 409, NOT_CLAIMED: 409,
  VERSION_CONFLICT: 409, FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400,
  // 503, not 500: the request was well-formed and the server is simply at
  // capacity right now. The distinction matters to the caller — 503 says
  // "retry this exact request", 500 says "something is broken, stop". See
  // `isCapacityError` in lib/rules/retry.ts for when this is raised.
  BUSY: 503,
}

export const statusFor = (code: RuleCode): number => HTTP_STATUS[code]
