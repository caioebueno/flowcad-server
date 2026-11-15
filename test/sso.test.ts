import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authed, db, makeApp, FakeSso } from "./helpers.js";

const verifierAndChallenge = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const device = () => ({ id: randomUUID(), name: "Mac" });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

const setup = (sso: FakeSso | null = new FakeSso()) => {
  const ctx = makeApp({ sso });
  const post = (path: string, body: unknown) =>
    ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string) => ctx.app.request(path);
  return { ...ctx, post, get };
};

/** Runs start and the browser callback; returns the hand-off code from the keel:// redirect. */
async function throughBrowser(t: ReturnType<typeof setup>, opts: { email: string; profileId?: string; profileEmail?: string; org?: string | null; dev?: { id: string; name: string } }) {
  const { verifier, challenge } = verifierAndChallenge();
  const dev = opts.dev ?? device();
  const start = await t.post("/v1/auth/sso/start", { email: opts.email, codeChallenge: challenge, device: dev });
  expect(start.status).toBe(200);
  const { authorizeUrl, state } = (await start.json()) as { authorizeUrl: string; state: string };
  expect(new URL(authorizeUrl).searchParams.get("state")).toBe(state);
  expect(new URL(authorizeUrl).searchParams.get("redirectUri")).toBe("https://api.keel.test/v1/auth/sso/callback");

  const workosCode = `wc_${randomUUID()}`;
  t.sso!.profiles.set(workosCode, {
    id: opts.profileId ?? `prof_${randomUUID()}`,
    email: opts.profileEmail ?? opts.email,
    organizationId: opts.org === undefined ? "org_acme" : opts.org,
    firstName: "Ada",
    lastName: "Lovelace",
  });
  const cb = await t.get(`/v1/auth/sso/callback?code=${workosCode}&state=${state}`);
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.get("location")!);
  expect(back.protocol).toBe("keel:");
  expect(back.searchParams.get("state")).toBe(state);
  return { code: back.searchParams.get("code"), error: back.searchParams.get("error"), verifier, dev };
}

describe("single sign-on", () => {
  it("signs up through the identity provider, then signs in to the same account", async () => {
    const t = setup();
    const email = `ada-${randomUUID().slice(0, 6)}@acme.test`;
    const profileId = `prof_${randomUUID()}`;

    const first = await throughBrowser(t, { email, profileId });
    const res = await t.post("/v1/auth/sso/verify", { code: first.code, codeVerifier: first.verifier, device: first.dev });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string; name: string; account: { id: string; created: boolean; plan: string } };
    expect(body.account).toMatchObject({ created: true, plan: "free" });
    expect(body.name).toBe("Ada Lovelace");

    const account = await t.app.request("/v1/account", { headers: authed(body.accessToken) });
    expect(account.status).toBe(200);

    const again = await throughBrowser(t, { email, profileId });
    const second = await t.post("/v1/auth/sso/verify", { code: again.code, codeVerifier: again.verifier, device: again.dev });
    expect(((await second.json()) as { account: { id: string; created: boolean } }).account).toMatchObject({ id: body.account.id, created: false });
  });

  it("opens an existing email account with the same address", async () => {
    const t = setup();
    const email = `grace-${randomUUID().slice(0, 6)}@acme.test`;
    const [existing] = await db()`insert into accounts (email, email_verified_at) values (${email}, now()) returning id`;
    const r = await throughBrowser(t, { email });
    const res = await t.post("/v1/auth/sso/verify", { code: r.code, codeVerifier: r.verifier, device: r.dev });
    expect(((await res.json()) as { account: { id: string; created: boolean } }).account).toMatchObject({ id: existing!.id, created: false });
  });

  it("says when the email's organization has no SSO", async () => {
    const t = setup();
    const res = await t.post("/v1/auth/sso/start", { email: "x@nowhere.test", codeChallenge: verifierAndChallenge().challenge, device: device() });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe("sso_not_configured");
  });

  it("answers 503 when WorkOS isn't configured", async () => {
    const t = setup(null);
    const res = await t.post("/v1/auth/sso/start", { email: "x@acme.test", codeChallenge: verifierAndChallenge().challenge, device: device() });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe("sso_unavailable");
  });

  it("rejects a profile from another organization", async () => {
    const t = setup();
    const r = await throughBrowser(t, { email: `m-${randomUUID().slice(0, 6)}@acme.test`, org: "org_other" });
    expect(r.code).toBeNull();
    expect(r.error).toBe("sso_failed");
  });

  it("needs the right verifier and device, and the hand-off code works once", async () => {
    const t = setup();
    const r = await throughBrowser(t, { email: `k-${randomUUID().slice(0, 6)}@acme.test` });
    const wrongVerifier = await t.post("/v1/auth/sso/verify", { code: r.code, codeVerifier: verifierAndChallenge().verifier, device: r.dev });
    expect(wrongVerifier.status).toBe(401);
    expect(await errorOf(wrongVerifier)).toBe("sso_failed");

    // A failed attempt spends the code, so a stolen code can't be retried.
    const retry = await t.post("/v1/auth/sso/verify", { code: r.code, codeVerifier: r.verifier, device: r.dev });
    expect(retry.status).toBe(401);

    const s = await throughBrowser(t, { email: `k-${randomUUID().slice(0, 6)}@acme.test` });
    const otherDevice = await t.post("/v1/auth/sso/verify", { code: s.code, codeVerifier: s.verifier, device: device() });
    expect(otherDevice.status).toBe(401);
  });

  it("sends the browser back to the app on a cancelled or unknown sign-in", async () => {
    const t = setup();
    const { challenge } = verifierAndChallenge();
    const start = await t.post("/v1/auth/sso/start", { email: "z@acme.test", codeChallenge: challenge, device: device() });
    const { state } = (await start.json()) as { state: string };
    const denied = await t.get(`/v1/auth/sso/callback?error=access_denied&state=${state}`);
    expect(denied.headers.get("location")).toBe(`keel://auth/sso?error=sso_failed&state=${state}`);
    const unknown = await t.get(`/v1/auth/sso/callback?code=x&state=nope`);
    expect(new URL(unknown.headers.get("location")!).searchParams.get("error")).toBe("sso_failed");
  });

  it("refuses a suspended account", async () => {
    const t = setup();
    const email = `s-${randomUUID().slice(0, 6)}@acme.test`;
    await db()`insert into accounts (email, email_verified_at, status) values (${email}, now(), 'suspended')`;
    const r = await throughBrowser(t, { email });
    const res = await t.post("/v1/auth/sso/verify", { code: r.code, codeVerifier: r.verifier, device: r.dev });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("account_suspended");
  });
});
