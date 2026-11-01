import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import type { Sql } from "../db/index.js";
import { ApiError } from "../errors.js";
import { parseJson } from "../util/validate.js";
import { IdentityTokenError } from "./apple.js";
import { requireAuth } from "./middleware.js";
import { issueRefreshToken, revokeDevice, rotateRefreshToken } from "./tokens.js";
import { normaliseEmail } from "./emailCodes.js";
import { log } from "../logger.js";

const Device = z.strictObject({
  id: z.uuid(),
  name: z.string().max(200).optional(),
  appVersion: z.string().max(50).optional(),
});
type Device = z.infer<typeof Device>;

/** App Attest (phase 2): key id and attestation object for a new key. */
const Attestation = z
  .strictObject({ keyId: z.string().max(200), attestationObject: z.string().max(65_536), clientDataHash: z.string().max(200) })
  .optional();

const SignInBody = z.strictObject({
  identityToken: z.string().min(1).max(8_192),
  /** The raw nonce the app put (hashed) into the Apple authorization request. */
  nonce: z.string().min(1).max(256).optional(),
  device: Device,
  attestation: Attestation,
});

const Email = z.string().trim().max(254).pipe(z.email());

const EmailStartBody = z.strictObject({ email: Email, device: Device });
const EmailVerifyBody = z.strictObject({
  email: Email,
  code: z.string().trim().max(12),
  device: Device,
  attestation: Attestation,
});

const RefreshBody = z.strictObject({ refreshToken: z.string().min(1).max(200) });

/** Client IP as Railway's proxy reports it. Used only for rate limits. */
export const clientIp = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

type AccountRow = { id: string; plan: string; status: string };

/** Registers (or re-registers) the device on the account, then issues tokens. */
async function completeSignIn(deps: Deps, account: AccountRow & { created: boolean }, device: Device, attestKeyId?: string) {
  if (account.status !== "active") throw new ApiError(403, "account_suspended", "Account is not active");
  await deps.sql.begin(async (tx) => {
    // A device id belongs to one account. If it shows up under another
    // account (reinstall, new Apple ID) the old row is replaced.
    const [existing] = await tx<{ account_id: string }[]>`select account_id from devices where id = ${device.id} for update`;
    if (existing && existing.account_id !== account.id) await tx`delete from devices where id = ${device.id}`;
    await tx`
      insert into devices (id, account_id, name, app_version, app_attest_key_id)
      values (${device.id}, ${account.id}, ${device.name ?? null}, ${device.appVersion ?? null}, ${attestKeyId ?? null})
      on conflict (id) do update set
        name = coalesce(excluded.name, devices.name),
        app_version = coalesce(excluded.app_version, devices.app_version),
        app_attest_key_id = coalesce(excluded.app_attest_key_id, devices.app_attest_key_id),
        last_seen_at = now(),
        revoked_at = null`;
  });
  const access = await deps.accessTokens.issue({ accountId: account.id, deviceId: device.id });
  const refresh = await issueRefreshToken(deps.sql, account.id, device.id);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
    account: { id: account.id, plan: account.plan, created: account.created },
  };
}

/**
 * Finds or creates the account for an Apple identity. A verified Apple email
 * that matches an email-only account opens that account (and links it).
 */
async function accountForApple(sql: Sql, appleUserId: string, email: string | null, emailVerified: boolean) {
  return sql.begin(async (tx) => {
    const [byApple] = await tx<AccountRow[]>`select id, plan, status from accounts where apple_user_id = ${appleUserId}`;
    if (byApple) {
      if (email) await tx`update accounts set email_relay = coalesce(email_relay, ${email}) where id = ${byApple.id}`;
      return { ...byApple, created: false };
    }
    const normalised = email ? normaliseEmail(email) : null;
    if (normalised && emailVerified) {
      const [byEmail] = await tx<AccountRow[]>`
        update accounts set apple_user_id = ${appleUserId}, email_relay = coalesce(email_relay, ${email})
        where email = ${normalised} and apple_user_id is null
        returning id, plan, status`;
      if (byEmail) return { ...byEmail, created: false };
    }
    const [taken] = normalised ? await tx`select 1 from accounts where email = ${normalised}` : [];
    const ownEmail = normalised && emailVerified && !taken ? normalised : null;
    const [created] = await tx<AccountRow[]>`
      insert into accounts (apple_user_id, email_relay, email, email_verified_at)
      values (${appleUserId}, ${email}, ${ownEmail}, ${ownEmail ? new Date() : null})
      returning id, plan, status`;
    return { ...created!, created: true };
  });
}

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  const checkAttestation = async (deviceId: string, attestation: z.infer<typeof Attestation>) => {
    if (!deps.attestation.enforced) return;
    const ok = await deps.attestation.verify({
      deviceId,
      keyId: attestation?.keyId,
      payload: attestation?.attestationObject,
      clientDataHash: attestation?.clientDataHash,
    });
    if (!ok) throw new ApiError(403, "attestation_failed", "App attestation failed");
  };

  app.post("/apple", async (c) => {
    const body = await parseJson(c, SignInBody);
    await checkAttestation(body.device.id, body.attestation);

    let identity;
    try {
      identity = await deps.apple.verify(body.identityToken, body.nonce);
    } catch (err) {
      if (err instanceof IdentityTokenError) throw new ApiError(401, "unauthorized", err.message);
      throw err;
    }

    const account = await accountForApple(deps.sql, identity.userId, identity.email, identity.emailVerified);
    const result = await completeSignIn(deps, account, body.device, body.attestation?.keyId);
    log.info("sign_in", { method: "apple", account: account.id, device: body.device.id, created: account.created });
    return c.json(result);
  });

  // Sign-up and sign-in by email are the same step: a code, then tokens.
  app.post("/email/start", async (c) => {
    const body = await parseJson(c, EmailStartBody);
    const email = normaliseEmail(body.email);
    const code = await deps.emailCodes.issue({ email, purpose: "sign_in", ip: clientIp(c), deviceId: body.device.id });
    try {
      await deps.mailer.sendSignInCode({ to: email, code });
    } catch (err) {
      log.error("email_send_failed", { err: (err as Error).message });
      throw new ApiError(503, "upstream_unavailable", "Couldn't send the email. Try again in a moment.");
    }
    // The same answer whether or not an account exists for this address.
    return c.json({ sent: true, expiresInSeconds: 600 }, 202);
  });

  app.post("/email/verify", async (c) => {
    const body = await parseJson(c, EmailVerifyBody);
    await checkAttestation(body.device.id, body.attestation);
    const email = normaliseEmail(body.email);
    await deps.emailCodes.verify({ email, code: body.code, purpose: "sign_in" });

    const [account] = await deps.sql<(AccountRow & { created: boolean })[]>`
      insert into accounts (email, email_verified_at) values (${email}, now())
      on conflict (email) do update set email_verified_at = coalesce(accounts.email_verified_at, now())
      returning id, plan, status, (xmax = 0) as created`;
    const result = await completeSignIn(deps, account!, body.device, body.attestation?.keyId);
    log.info("sign_in", { method: "email", account: account!.id, device: body.device.id, created: account!.created });
    return c.json(result);
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

/** Settings > Link email: attach a verified email to the signed-in account. */
export function linkEmailRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const Body = z.strictObject({ email: Email });
  const Verify = z.strictObject({ email: Email, code: z.string().trim().max(12) });

  app.post("/email/start", async (c) => {
    const { accountId } = c.get("auth");
    const email = normaliseEmail((await parseJson(c, Body)).email);
    const [owner] = await deps.sql<{ id: string }[]>`select id from accounts where email = ${email}`;
    if (owner && owner.id !== accountId) throw new ApiError(409, "email_taken", "That email belongs to another Keel account");
    const code = await deps.emailCodes.issue({ email, purpose: "link", ip: clientIp(c), accountId });
    await deps.mailer.sendSignInCode({ to: email, code }).catch(() => {
      throw new ApiError(503, "upstream_unavailable", "Couldn't send the email. Try again in a moment.");
    });
    return c.json({ sent: true, expiresInSeconds: 600 }, 202);
  });

  app.post("/email/verify", async (c) => {
    const { accountId } = c.get("auth");
    const body = await parseJson(c, Verify);
    const email = normaliseEmail(body.email);
    await deps.emailCodes.verify({ email, code: body.code, purpose: "link", accountId });
    try {
      await deps.sql`update accounts set email = ${email}, email_verified_at = now() where id = ${accountId}`;
    } catch {
      throw new ApiError(409, "email_taken", "That email belongs to another Keel account");
    }
    return c.json({ email });
  });

  return app;
}
