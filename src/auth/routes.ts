import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { parseJson } from "../util/validate.js";
import { IdentityTokenError } from "./apple.js";
import { requireAuth } from "./middleware.js";
import { issueRefreshToken, revokeDevice, rotateRefreshToken } from "./tokens.js";
import { log } from "../logger.js";

const SignInBody = z.strictObject({
  identityToken: z.string().min(1).max(8_192),
  /** The raw nonce the app put (hashed) into the Apple authorization request. */
  nonce: z.string().min(1).max(256).optional(),
  device: z.strictObject({
    id: z.uuid(),
    name: z.string().max(200).optional(),
    appVersion: z.string().max(50).optional(),
  }),
  /** App Attest (phase 2): key id and attestation object for a new key. */
  attestation: z
    .strictObject({ keyId: z.string().max(200), attestationObject: z.string().max(65_536), clientDataHash: z.string().max(200) })
    .optional(),
});

const RefreshBody = z.strictObject({ refreshToken: z.string().min(1).max(200) });

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.post("/apple", async (c) => {
    const body = await parseJson(c, SignInBody);

    if (deps.attestation.enforced) {
      const ok = await deps.attestation.verify({
        deviceId: body.device.id,
        keyId: body.attestation?.keyId,
        payload: body.attestation?.attestationObject,
        clientDataHash: body.attestation?.clientDataHash,
      });
      if (!ok) throw new ApiError(403, "attestation_failed", "App attestation failed");
    }

    let identity;
    try {
      identity = await deps.apple.verify(body.identityToken, body.nonce);
    } catch (err) {
      if (err instanceof IdentityTokenError) throw new ApiError(401, "unauthorized", err.message);
      throw err;
    }

    const result = await deps.sql.begin(async (tx) => {
      const [account] = await tx<{ id: string; plan: string; status: string; created: boolean }[]>`
        insert into accounts (apple_user_id, email_relay)
        values (${identity.userId}, ${identity.email})
        on conflict (apple_user_id) do update
          set email_relay = coalesce(excluded.email_relay, accounts.email_relay)
        returning id, plan, status, (xmax = 0) as created`;
      if (account!.status !== "active") return { account: account!, device: null };

      // A device id belongs to one account. If it shows up under another
      // account (reinstall, new Apple ID) the old row is replaced.
      const [device] = await tx<{ id: string; account_id: string; revoked_at: Date | null }[]>`
        select id, account_id, revoked_at from devices where id = ${body.device.id} for update`;
      if (device && device.account_id !== account!.id) {
        await tx`delete from devices where id = ${body.device.id}`;
      }
      await tx`
        insert into devices (id, account_id, name, app_version, app_attest_key_id)
        values (${body.device.id}, ${account!.id}, ${body.device.name ?? null}, ${body.device.appVersion ?? null},
                ${body.attestation?.keyId ?? null})
        on conflict (id) do update set
          name = coalesce(excluded.name, devices.name),
          app_version = coalesce(excluded.app_version, devices.app_version),
          app_attest_key_id = coalesce(excluded.app_attest_key_id, devices.app_attest_key_id),
          last_seen_at = now(),
          revoked_at = null`;
      return { account: account!, device: body.device.id };
    });

    if (!result.device) throw new ApiError(403, "account_suspended", "Account is not active");

    const access = await deps.accessTokens.issue({ accountId: result.account.id, deviceId: result.device });
    const refresh = await issueRefreshToken(deps.sql, result.account.id, result.device);
    log.info("sign_in", { account: result.account.id, device: result.device, created: result.account.created });

    return c.json({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      account: { id: result.account.id, plan: result.account.plan, created: result.account.created },
    });
  });

  app.post("/refresh", async (c) => {
    const { refreshToken } = await parseJson(c, RefreshBody);
    const result = await rotateRefreshToken(deps.sql, refreshToken);
    if (!result.ok) {
      if (result.reason === "reused") log.warn("refresh_token_reused");
      if (result.reason === "account_inactive") throw new ApiError(403, "account_suspended", "Account is not active");
      throw new ApiError(401, "refresh_token_invalid", "Sign in again", { reason: result.reason });
    }
    const access = await deps.accessTokens.issue({ accountId: result.accountId, deviceId: result.deviceId });
    return c.json({
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: result.next.token,
      refreshTokenExpiresAt: result.next.expiresAt.toISOString(),
    });
  });

  app.post("/logout", requireAuth(deps), async (c) => {
    await revokeDevice(deps.sql, c.get("auth").deviceId);
    return c.body(null, 204);
  });

  return app;
}
