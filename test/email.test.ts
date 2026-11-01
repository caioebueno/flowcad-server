import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appleToken, authed, db, makeApp } from "./helpers.js";

const setup = () => {
  const ctx = makeApp();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    ctx.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
      body: JSON.stringify(body),
    });
  return { ...ctx, post };
};
const newEmail = () => `user-${randomUUID().slice(0, 8)}@example.com`;
const device = () => ({ id: randomUUID(), name: "Mac" });
const code = async (res: Response) => ((await res.json()) as { error: { code: string; details?: { reason?: string } } }).error;

describe("email sign-in", () => {
  it("signs up with a code, then signs in to the same account", async () => {
    const { post, mailer } = setup();
    const email = newEmail();
    const start = await post("/v1/auth/email/start", { email: `  ${email.toUpperCase()} `, device: device() });
    expect(start.status).toBe(202);
    const sent = mailer.codes.get(email)!;
    expect(sent).toMatch(/^\d{6}$/);

    const verify = await post("/v1/auth/email/verify", { email, code: sent, device: device() });
    expect(verify.status).toBe(200);
    const first = (await verify.json()) as { accessToken: string; account: { id: string; created: boolean; plan: string } };
    expect(first.account).toMatchObject({ created: true, plan: "free" });

    await db()`update email_codes set created_at = created_at - interval '1 minute' where email = ${email}`;
    await post("/v1/auth/email/start", { email, device: device() });
    const again = await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() });
    const second = (await again.json()) as { account: { id: string; created: boolean } };
    expect(second.account).toEqual({ ...second.account, id: first.account.id, created: false });

    const [row] = await db()`select code_hash from email_codes where email = ${email} limit 1`;
    expect(Buffer.from(row!.code_hash).toString()).not.toContain(sent);
  });

  it("answers the same way for an address with no account", async () => {
    const { post } = setup();
    const res = await post("/v1/auth/email/start", { email: newEmail(), device: device() });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true, expiresInSeconds: 600 });
  });

  it("ends the code after five wrong tries", async () => {
    const { post, mailer } = setup();
    const email = newEmail();
    await post("/v1/auth/email/start", { email, device: device() });
    const real = mailer.codes.get(email)!;
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      const res = await post("/v1/auth/email/verify", { email, code: wrong, device: device() });
      expect((await code(res)).details?.reason).toBe("wrong");
    }
    const fifth = await post("/v1/auth/email/verify", { email, code: wrong, device: device() });
    expect((await code(fifth)).details?.reason).toBe("too_many_tries");
    const late = await post("/v1/auth/email/verify", { email, code: real, device: device() });
    expect(late.status).toBe(401);
  });

  it("rejects expired codes and codes replaced by a newer one", async () => {
    const { post, mailer } = setup();
    const email = newEmail();
    await post("/v1/auth/email/start", { email, device: device() });
    const old = mailer.codes.get(email)!;
    await db()`update email_codes set created_at = created_at - interval '1 minute' where email = ${email}`;
    await post("/v1/auth/email/start", { email, device: device() });
    const replaced = await post("/v1/auth/email/verify", { email, code: old, device: device() });
    expect(replaced.status).toBe(401);

    await db()`update email_codes set expires_at = now() - interval '1 second' where email = ${email}`;
    const expired = await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() });
    expect((await code(expired)).details?.reason).toBe("expired");
  });

  it("rate limits codes: 30 s between sends and 5 per email per hour", async () => {
    const { post } = setup();
    const email = newEmail();
    expect((await post("/v1/auth/email/start", { email, device: device() })).status).toBe(202);
    const tooSoon = await post("/v1/auth/email/start", { email, device: device() });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers.get("retry-after")).toBeTruthy();
    for (let i = 0; i < 4; i++) {
      await db()`update email_codes set created_at = created_at - interval '1 minute' where email = ${email}`;
      expect((await post("/v1/auth/email/start", { email, device: device() })).status).toBe(202);
    }
    await db()`update email_codes set created_at = created_at - interval '1 minute' where email = ${email}`;
    expect((await post("/v1/auth/email/start", { email, device: device() })).status).toBe(429);
  });

  it("rate limits codes per IP", async () => {
    const { post } = setup();
    const ip = { "x-forwarded-for": "203.0.113.77" };
    for (let i = 0; i < 10; i++) expect((await post("/v1/auth/email/start", { email: newEmail(), device: device() }, ip)).status).toBe(202);
    expect((await post("/v1/auth/email/start", { email: newEmail(), device: device() }, ip)).status).toBe(429);
  });

  it("returns 503 when the email can't be sent", async () => {
    const { post, mailer } = setup();
    mailer.fail = true;
    expect((await post("/v1/auth/email/start", { email: newEmail(), device: device() })).status).toBe(503);
  });

  it("rejects malformed addresses", async () => {
    const { post } = setup();
    expect((await post("/v1/auth/email/start", { email: "not-an-email", device: device() })).status).toBe(400);
  });
});

describe("one account per person", () => {
  it("opens the email account when Apple brings the same verified email", async () => {
    const { post, mailer } = setup();
    const email = newEmail();
    await post("/v1/auth/email/start", { email, device: device() });
    const byEmail = (await (await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() })).json()) as {
      account: { id: string };
    };
    const apple = await post("/v1/auth/apple", { identityToken: await appleToken(`apple-${randomUUID()}`, { email }), device: device() });
    const byApple = (await apple.json()) as { account: { id: string; created: boolean } };
    expect(byApple.account).toMatchObject({ id: byEmail.account.id, created: false });
  });

  it("does not link an unverified Apple email", async () => {
    const { post, mailer } = setup();
    const email = newEmail();
    await post("/v1/auth/email/start", { email, device: device() });
    const byEmail = (await (await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() })).json()) as {
      account: { id: string };
    };
    const token = await appleToken(`apple-${randomUUID()}`, { email, emailVerified: false });
    const byApple = (await (await post("/v1/auth/apple", { identityToken: token, device: device() })).json()) as { account: { id: string } };
    expect(byApple.account.id).not.toBe(byEmail.account.id);
  });

  it("lets an Apple account link an email from Settings", async () => {
    const { post, mailer, app } = setup();
    const apple = (await (
      await post("/v1/auth/apple", { identityToken: await appleToken(`apple-${randomUUID()}`, { email: "x@privaterelay.appleid.com" }), device: device() })
    ).json()) as { accessToken: string; account: { id: string } };
    const email = newEmail();
    const h = authed(apple.accessToken);
    expect((await app.request("/v1/account/email/start", { method: "POST", headers: h, body: JSON.stringify({ email }) })).status).toBe(202);
    const verify = await app.request("/v1/account/email/verify", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ email, code: mailer.codes.get(email) }),
    });
    expect(verify.status).toBe(200);
    // Signing in by email now opens the Apple account.
    await db()`update email_codes set created_at = created_at - interval '1 minute' where email = ${email}`;
    await post("/v1/auth/email/start", { email, device: device() });
    const byEmail = (await (await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() })).json()) as {
      account: { id: string };
    };
    expect(byEmail.account.id).toBe(apple.account.id);
    const account = (await (await app.request("/v1/account", { headers: h })).json()) as { signInMethods: string[] };
    expect(account.signInMethods.sort()).toEqual(["apple", "email"]);
  });

  it("refuses to link an email that belongs to another account", async () => {
    const { post, mailer, app } = setup();
    const email = newEmail();
    await post("/v1/auth/email/start", { email, device: device() });
    await post("/v1/auth/email/verify", { email, code: mailer.codes.get(email)!, device: device() });
    const apple = (await (await post("/v1/auth/apple", { identityToken: await appleToken(`apple-${randomUUID()}`), device: device() })).json()) as {
      accessToken: string;
    };
    const res = await app.request("/v1/account/email/start", { method: "POST", headers: authed(apple.accessToken), body: JSON.stringify({ email }) });
    expect(res.status).toBe(409);
  });
});
