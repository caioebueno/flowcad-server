import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import type { Sql } from "../db/index.js";
import { ApiError } from "../errors.js";
import { parseJson } from "../util/validate.js";
import { log } from "../logger.js";
import { normaliseEmail } from "./emailCodes.js";
import { SsoProviderError } from "./sso.js";
import { Attestation, Device, completeSignIn, type AccountRow } from "./routes.js";

/** From start to verify: the browser round trip and the identity provider's own sign-in. */
export const SSO_LOGIN_TTL_MINUTES = 10;

const Email = z.string().trim().max(254).pipe(z.email());
/** base64url SHA-256 of the app's verifier: 43 characters (RFC 7636, S256). */
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** RFC 7636 verifier: 43 to 128 unreserved characters. */
const Verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

const StartBody = z.strictObject({ email: Email, codeChallenge: Challenge, device: Device });
const VerifyBody = z.strictObject({ code: z.string().min(1).max(200), codeVerifier: Verifier, device: Device, attestation: Attestation });

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const token = () => randomBytes(32).toString("base64url");

/**
 * Finds or creates the account for an SSO profile. A returning person is found
 * by their WorkOS profile id; otherwise an account with the same email opens
 * (the company's identity provider vouches for the address) and is linked.
 */
async function accountForSso(sql: Sql, profileId: string, email: string, organizationId: string) {
  return sql.begin(async (tx) => {
    const [bySso] = await tx<AccountRow[]>`select id, plan, status from accounts where sso_user_id = ${profileId}`;
    if (bySso) return { ...bySso, created: false };
    const [byEmail] = await tx<AccountRow[]>`
      update accounts set sso_user_id = ${profileId}, sso_organization_id = ${organizationId},
        email_verified_at = coalesce(email_verified_at, now())
      where email = ${email} and sso_user_id is null
      returning id, plan, status`;
    if (byEmail) return { ...byEmail, created: false };
    const [created] = await tx<AccountRow[]>`
      insert into accounts (email, email_verified_at, sso_user_id, sso_organization_id)
      values (${email}, now(), ${profileId}, ${organizationId})
      returning id, plan, status`;
    return { ...created!, created: true };
  });
}

/**
 * Single Sign-On (Continue with Single Sign-On on the sign-in screen).
 *
 * 1. The app posts the work email and a PKCE challenge to /sso/start and opens
 *    the returned URL in a web authentication session.
 * 2. WorkOS sends the browser back to /sso/callback with a code; this service
 *    exchanges it for the profile, finds or creates the account, and redirects
 *    to keel://auth/sso with a one-time hand-off code.
 * 3. The app posts that code and its PKCE verifier to /sso/verify for tokens.
 */
export function ssoRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const redirectUri = `${deps.publicBaseUrl}/v1/auth/sso/callback`;
  const provider = () => {
    if (!deps.sso) throw new ApiError(503, "sso_unavailable", "Single Sign-On isn't available right now");
    return deps.sso;
  };

  app.post("/start", async (c) => {
    const sso = provider();
    const body = await parseJson(c, StartBody);
    const email = normaliseEmail(body.email);
    const domain = email.split("@")[1]!;
    let organizationId: string | null;
    try {
      organizationId = await sso.organizationForDomain(domain);
    } catch (err) {
      log.error("sso_lookup_failed", { err: (err as Error).message });
      throw new ApiError(503, "upstream_unavailable", "Couldn't reach Single Sign-On. Try again in a moment.");
    }
    if (!organizationId) {
      throw new ApiError(404, "sso_not_configured", "This email's organization doesn't use Single Sign-On with Keel", { domain });
    }
    const state = token();
    await deps.sql`
      insert into sso_logins (state_hash, code_challenge, device_id, organization_id, email_domain, expires_at)
      values (${sha256(state)}, ${body.codeChallenge}, ${body.device.id}, ${organizationId}, ${domain},
              now() + make_interval(mins => ${SSO_LOGIN_TTL_MINUTES}))`;
    const authorizeUrl = sso.authorizeUrl({ organizationId, redirectUri, state, loginHint: email });
    return c.json({ authorizeUrl, state, expiresInSeconds: SSO_LOGIN_TTL_MINUTES * 60 });
  });

  // The browser lands here, so every outcome is a redirect back to the app.
  app.get("/callback", async (c) => {
    const back = (params: Record<string, string>) => {
      const url = new URL(deps.ssoAppCallback);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      return c.redirect(url.toString(), 302);
    };
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state) return back({ error: "sso_failed" });

    const [login] = await deps.sql<{ id: string; organization_id: string; email_domain: string }[]>`
      select id, organization_id, email_domain from sso_logins
      where state_hash = ${sha256(state)} and handoff_hash is null and used_at is null and expires_at > now()`;
    if (!login) return back({ error: "sso_failed", state });
    if (c.req.query("error") || !code) {
      log.warn("sso_denied", { error: c.req.query("error") ?? "no_code" });
      return back({ error: "sso_failed", state });
    }

    let profile;
    try {
      profile = await provider().profile(code);
    } catch (err) {
      log.error("sso_exchange_failed", { err: (err as Error).message, provider: err instanceof SsoProviderError });
      return back({ error: "sso_failed", state });
    }
    // The profile must come from the organization the start step chose.
    if (profile.organizationId !== login.organization_id) {
      log.warn("sso_organization_mismatch");
      return back({ error: "sso_failed", state });
    }

    const account = await accountForSso(deps.sql, profile.id, normaliseEmail(profile.email), login.organization_id);
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    const handoff = token();
    await deps.sql`
      update sso_logins set handoff_hash = ${sha256(handoff)}, account_id = ${account.id},
        account_created = ${account.created}, display_name = ${name}
      where id = ${login.id}`;
    return back({ code: handoff, state });
  });

  app.post("/verify", async (c) => {
    provider();
    const body = await parseJson(c, VerifyBody);
    const [login] = await deps.sql<
      { id: string; code_challenge: string; device_id: string; account_id: string; account_created: boolean; display_name: string | null }[]
    >`
      update sso_logins set used_at = now()
      where handoff_hash = ${sha256(body.code)} and used_at is null and expires_at > now()
      returning id, code_challenge, device_id, account_id, account_created, display_name`;
    const challenge = createHash("sha256").update(body.codeVerifier).digest("base64url");
    const matches =
      !!login &&
      login.device_id === body.device.id &&
      challenge.length === login.code_challenge.length &&
      timingSafeEqual(Buffer.from(challenge), Buffer.from(login.code_challenge));
    if (!login || !matches) throw new ApiError(401, "sso_failed", "Single Sign-On didn't finish. Try again.");

    const [row] = await deps.sql<AccountRow[]>`select id, plan, status from accounts where id = ${login.account_id}`;
    const result = await completeSignIn(deps, { ...row!, created: login.account_created }, body.device, body.attestation?.keyId);
    log.info("sign_in", { method: "sso", account: row!.id, device: body.device.id, created: login.account_created });
    return c.json({ ...result, name: login.display_name });
  });

  return app;
}
