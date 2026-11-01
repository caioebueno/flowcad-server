/**
 * Error codes shared with the Mac app. HTTP errors carry the same `code` as the
 * `keel.error` event sent when something goes wrong mid stream.
 */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "token_expired"
  | "refresh_token_invalid"
  | "code_invalid"
  | "email_taken"
  | "plan_required"
  | "already_subscribed"
  | "billing_unavailable"
  | "billing_error"
  | "allowance_exhausted"
  | "credits_exhausted"
  | "packs_unavailable_during_trial"
  | "not_trialing"
  | "attestation_failed"
  | "app_too_old"
  | "account_suspended"
  | "not_found"
  | "request_too_large"
  | "outside_task_profile"
  | "run_limit_reached"
  | "rate_limited"
  | "upstream_error"
  | "upstream_unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const unauthorized = (msg = "Missing or invalid access token") => new ApiError(401, "unauthorized", msg);
export const outsideProfile = (msg: string, details?: Record<string, unknown>) =>
  new ApiError(422, "outside_task_profile", msg, details);
