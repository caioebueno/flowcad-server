import { createMiddleware } from "hono/factory";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError, unauthorized } from "../errors.js";
import { compareVersions } from "../util/version.js";

/** Requires a valid access token for a device that has not been revoked. */
export function requireAuth(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw unauthorized();
    const claims = await deps.accessTokens.verify(token);
    if (claims === "expired") throw new ApiError(401, "token_expired", "Access token expired");
    if (!claims) throw unauthorized();

    const [row] = await deps.sql<{ revoked_at: Date | null; status: string }[]>`
      select d.revoked_at, a.status from devices d join accounts a on a.id = d.account_id
      where d.id = ${claims.deviceId} and d.account_id = ${claims.accountId}`;
    if (!row || row.revoked_at) throw unauthorized("Device revoked");
    if (row.status !== "active") throw new ApiError(403, "account_suspended", "Account is not active");

    c.set("auth", claims);
    await next();
  });
}

/** Rejects app builds older than the config's minimum version. */
export function requireAppVersion(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { doc } = await deps.config.current();
    const version = c.req.header("x-keel-app-version");
    if (version && compareVersions(version, doc.minAppVersion) < 0) {
      throw new ApiError(403, "app_too_old", "Please update Keel", { minAppVersion: doc.minAppVersion });
    }
    await next();
  });
}

/** App Attest assertion on agent and batch requests. A no-op until phase 2 turns it on. */
export function requireAttestation(deps: Deps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (deps.attestation.enforced) {
      const ok = await deps.attestation.verify({
        deviceId: c.get("auth").deviceId,
        keyId: c.req.header("x-keel-attest-key") ?? undefined,
        payload: c.req.header("x-keel-attest-assertion") ?? undefined,
        clientDataHash: c.req.header("x-keel-attest-client-data") ?? undefined,
      });
      if (!ok) throw new ApiError(403, "attestation_failed", "App attestation failed");
    }
    await next();
  });
}
