import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Sql } from "../db/index.js";
import { ApiError } from "../errors.js";

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
export const MAX_CODES_PER_IP_PER_HOUR = 10;
export const RESEND_COOLDOWN_SECONDS = 30;

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export type CodePurpose = "sign_in" | "link";

export class EmailCodes {
  constructor(
    private readonly sql: Sql,
    private readonly secret: string,
  ) {}

  private hash(email: string, code: string): Buffer {
    return createHmac("sha256", this.secret).update(`email-code:${email}:${code}`).digest();
  }

  /**
   * Creates a code for this email, replacing any earlier one, after the rate
   * limits. Returns the code so the caller can mail it.
   */
  async issue(opts: { email: string; purpose: CodePurpose; ip: string; deviceId?: string; accountId?: string }): Promise<string> {
    const { email, purpose, ip } = opts;
    const [counts] = await this.sql<{ per_email: number; per_ip: number; last_seconds: number | null }[]>`
      select
        (select count(*)::bigint from email_codes where email = ${email} and created_at > now() - interval '1 hour') as per_email,
        (select count(*)::bigint from email_codes where ip = ${ip} and created_at > now() - interval '1 hour') as per_ip,
        (select extract(epoch from now() - max(created_at))::float8 from email_codes where email = ${email}) as last_seconds`;
    if (counts!.last_seconds !== null && counts!.last_seconds < RESEND_COOLDOWN_SECONDS) {
      const retryAfter = Math.ceil(RESEND_COOLDOWN_SECONDS - counts!.last_seconds);
      throw new ApiError(429, "rate_limited", "Wait before asking for another code", { retryAfter });
    }
    if (counts!.per_email >= MAX_CODES_PER_EMAIL_PER_HOUR || counts!.per_ip >= MAX_CODES_PER_IP_PER_HOUR) {
      throw new ApiError(429, "rate_limited", "Too many codes sent. Try again later.", { retryAfter: 600 });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.sql.begin(async (tx) => {
      await tx`update email_codes set used_at = now() where email = ${email} and used_at is null`;
      await tx`
        insert into email_codes (email, code_hash, purpose, account_id, device_id, ip, expires_at)
        values (${email}, ${this.hash(email, code)}, ${purpose}, ${opts.accountId ?? null}, ${opts.deviceId ?? null}, ${ip},
                now() + make_interval(mins => ${CODE_TTL_MINUTES}))`;
    });
    return code;
  }

  /** Checks a code. Each wrong try counts; the fifth ends the code. */
  async verify(opts: { email: string; code: string; purpose: CodePurpose; accountId?: string }): Promise<void> {
    const { email, code, purpose } = opts;
    const outcome = await this.sql.begin(async (tx) => {
      const [row] = await tx<{ id: string; code_hash: Buffer; attempts: number; expired: boolean; account_id: string | null }[]>`
        select id, code_hash, attempts, expires_at <= now() as expired, account_id
        from email_codes
        where email = ${email} and purpose = ${purpose} and used_at is null
        order by created_at desc limit 1
        for update`;
      if (!row || row.expired) return "expired" as const;
      if (purpose === "link" && row.account_id !== opts.accountId) return "expired" as const;
      const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(row.code_hash), this.hash(email, code));
      if (ok) {
        await tx`update email_codes set used_at = now() where id = ${row.id}`;
        return "ok" as const;
      }
      const attempts = row.attempts + 1;
      await tx`update email_codes set attempts = ${attempts}, used_at = ${attempts >= MAX_ATTEMPTS ? new Date() : null}
               where id = ${row.id}`;
      return attempts >= MAX_ATTEMPTS ? ("too_many_tries" as const) : ("wrong" as const);
    });
    if (outcome === "ok") return;
    const message =
      outcome === "too_many_tries"
        ? "Too many tries. Send a new code."
        : outcome === "expired"
          ? "That code has expired. Send a new one."
          : "That code didn't work. Check it or send a new one.";
    throw new ApiError(401, "code_invalid", message, { reason: outcome });
  }
}
