import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Sql } from "../db/index.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_DAYS = 60;
/**
 * How long a just-rotated refresh token still works, so two refreshes sent at
 * once, or a retry after the response was lost, don't sign the user out. It
 * works only while the token that replaced it hasn't been used yet.
 */
export const REFRESH_GRACE_SECONDS = 60;
/**
 * At most this many extra tokens per rotated token inside the grace window:
 * enough for every request that hit token_expired at once to refresh, but a
 * bound on the chains a stolen token can start without reuse detection.
 */
export const REFRESH_GRACE_MAX_SIBLINGS = 8;
const ISSUER = "keel-account-service";
const AUDIENCE = "keel-app";

export interface AccessClaims {
  accountId: string;
  deviceId: string;
}

export class AccessTokens {
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: AccessClaims, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
    const exp = Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ did: claims.deviceId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.accountId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Returns the claims, "expired", or null for anything else that is wrong. */
  async verify(token: string): Promise<AccessClaims | "expired" | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
      if (typeof payload.sub !== "string" || typeof payload.did !== "string") return null;
      return { accountId: payload.sub, deviceId: payload.did };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return "expired";
      return null;
    }
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

export interface IssuedRefreshToken {
  token: string;
  id: string;
  expiresAt: Date;
}

export async function issueRefreshToken(sql: Sql, accountId: string, deviceId: string): Promise<IssuedRefreshToken> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await sql<{ id: string; expires_at: Date }[]>`
    insert into refresh_tokens (token_hash, device_id, account_id, expires_at)
    values (${hashToken(token)}, ${deviceId}, ${accountId}, now() + make_interval(days => ${REFRESH_TOKEN_TTL_DAYS}))
    returning id, expires_at`;
  return { token, id: row!.id, expiresAt: row!.expires_at };
}

export type RotateResult =
  | { ok: true; accountId: string; deviceId: string; next: IssuedRefreshToken }
  | { ok: false; reason: "unknown" | "expired" | "reused" | "device_revoked" | "account_inactive" };

/**
 * Swaps a refresh token for a new one. Tokens are single use: presenting one
 * that was already rotated means it leaked, so the whole device is revoked.
 * The exception is a token rotated in the last REFRESH_GRACE_SECONDS whose
 * replacement hasn't been used: that is the app refreshing twice at once or
 * retrying, so it gets a fresh token and the replacement stays valid. Up to
 * REFRESH_GRACE_MAX_SIBLINGS of them; one more counts as reuse and revokes the
 * device, as does any use once the replacement has been used.
 */
export async function rotateRefreshToken(sql: Sql, token: string): Promise<RotateResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      {
        id: string;
        device_id: string;
        account_id: string;
        expired: boolean;
        revoked_at: Date | null;
        device_revoked_at: Date | null;
        account_status: string;
        in_grace: boolean;
        replaced_by: string | null;
      }[]
    >`
      select rt.id, rt.device_id, rt.account_id, rt.expires_at <= now() as expired, rt.revoked_at,
             d.revoked_at as device_revoked_at, a.status as account_status,
             (rt.replaced_by is not null and rt.revoked_at > now() - make_interval(secs => ${REFRESH_GRACE_SECONDS})
              and successor.revoked_at is null) as in_grace, rt.replaced_by
      from refresh_tokens rt
      join devices d on d.id = rt.device_id
      join accounts a on a.id = rt.account_id
      left join refresh_tokens successor on successor.id = rt.replaced_by
      where rt.token_hash = ${hashToken(token)}
      for update of rt`;
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.device_revoked_at) return { ok: false, reason: "device_revoked" } as const;
    // Counted in its own statement, after the lock, so it sees siblings that refreshes we waited on just made.
    const siblings =
      row.revoked_at && row.in_grace
        ? (
            await tx<{ n: number }[]>`
              select count(*)::bigint as n from refresh_tokens
              where device_id = ${row.device_id} and created_at > ${row.revoked_at} and id <> ${row.replaced_by}`
          )[0]!.n
        : 0;
    if (row.revoked_at && (!row.in_grace || siblings >= REFRESH_GRACE_MAX_SIBLINGS)) {
      // Reuse after the replacement was used, past the window, or one repeat too many.
      await revokeDevice(tx as unknown as Sql, row.device_id);
      return { ok: false, reason: "reused" } as const;
    }
    if (row.expired) return { ok: false, reason: "expired" } as const;
    if (row.account_status !== "active") return { ok: false, reason: "account_inactive" } as const;
    if (row.revoked_at) {
      // A repeat inside the grace window: a sibling token, leaving the first replacement (and replaced_by) as they are.
      const next = await issueRefreshToken(tx as unknown as Sql, row.account_id, row.device_id);
      return { ok: true, accountId: row.account_id, deviceId: row.device_id, next } as const;
    }

    const next = await issueRefreshToken(tx as unknown as Sql, row.account_id, row.device_id);
    await tx`update refresh_tokens set revoked_at = now(), replaced_by = ${next.id} where id = ${row.id}`;
    await tx`update devices set last_seen_at = now() where id = ${row.device_id}`;
    return { ok: true, accountId: row.account_id, deviceId: row.device_id, next } as const;
  });
}

export async function revokeDevice(sql: Sql, deviceId: string): Promise<void> {
  await sql`update devices set revoked_at = coalesce(revoked_at, now()) where id = ${deviceId}`;
  await sql`update refresh_tokens set revoked_at = now() where device_id = ${deviceId} and revoked_at is null`;
}
