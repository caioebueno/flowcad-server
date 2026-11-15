import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appleToken, authed, db, makeApp, signIn } from "./helpers.js";

const { app } = makeApp();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("health", () => {
  it("answers without a token", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
  });
});

describe("Sign in with Apple", () => {
  it("creates an account once and finds it after", async () => {
    const sub = `apple-${randomUUID()}`;
    const first = await signIn(app, sub);
    const second = await signIn(app, sub);
    expect(first.account.id).toBe(second.account.id);
    const [row] = await db()`select count(*)::int as n from accounts where apple_user_id = ${sub}`;
    expect(row!.n).toBe(1);
  });

  it("rejects a token for another app", async () => {
    const res = await post("/v1/auth/apple", {
      identityToken: await appleToken("x", { aud: "com.someone.else" }),
      device: { id: randomUUID() },
    });
    expect(res.status).toBe(401);
  });

  it("checks the nonce when one is sent", async () => {
    const token = await appleToken("nonce-user", { nonce: "abc" });
    const bad = await post("/v1/auth/apple", { identityToken: token, nonce: "xyz", device: { id: randomUUID() } });
    expect(bad.status).toBe(401);
    const good = await post("/v1/auth/apple", { identityToken: token, nonce: "abc", device: { id: randomUUID() } });
    expect(good.status).toBe(200);
  });

  it("rejects unknown fields", async () => {
    const res = await post("/v1/auth/apple", { identityToken: await appleToken("u"), device: { id: randomUUID() }, admin: true });
    expect(res.status).toBe(400);
  });

  it("stores refresh tokens only as hashes", async () => {
    const s = await signIn(app);
    const rows = await db()`select token_hash from refresh_tokens where account_id = ${s.account.id}`;
    expect(rows.length).toBe(1);
    expect(Buffer.from(rows[0]!.token_hash).toString("base64url")).not.toBe(s.refreshToken);
  });
});

describe("refresh and logout", () => {
  it("rotates refresh tokens", async () => {
    const s = await signIn(app);
    const res = await post("/v1/auth/refresh", { refreshToken: s.refreshToken });
    expect(res.status).toBe(200);
    const next = (await res.json()) as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(s.refreshToken);
    expect((await app.request("/v1/account", { headers: authed(next.accessToken) })).status).toBe(200);
  });

  it("revokes the device when an old refresh token is reused after its replacement was used", async () => {
    const s = await signIn(app);
    const first = (await (await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).json()) as { refreshToken: string };
    const second = (await (await post("/v1/auth/refresh", { refreshToken: first.refreshToken })).json()) as { refreshToken: string };
    const reuse = await post("/v1/auth/refresh", { refreshToken: s.refreshToken });
    expect(reuse.status).toBe(401);
    // The newer token and the access token die with the device.
    expect((await post("/v1/auth/refresh", { refreshToken: second.refreshToken })).status).toBe(401);
    expect((await app.request("/v1/account", { headers: authed(s.accessToken) })).status).toBe(401);
  });

  it("revokes the device when a rotated token comes back after the grace window", async () => {
    const s = await signIn(app);
    const first = (await (await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).json()) as { refreshToken: string };
    await db()`update refresh_tokens set revoked_at = now() - interval '2 minutes' where device_id = ${s.deviceId} and replaced_by is not null`;
    expect((await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: first.refreshToken })).status).toBe(401);
  });

  it("keeps the user signed in when two refreshes with the same token race", async () => {
    const s = await signIn(app);
    const results = await Promise.all([1, 2].map(() => post("/v1/auth/refresh", { refreshToken: s.refreshToken })));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const tokens = (await Promise.all(results.map((r) => r.json()))) as { refreshToken: string; accessToken: string }[];
    // Both new tokens work, and the device is still signed in.
    for (const t of tokens) {
      expect((await post("/v1/auth/refresh", { refreshToken: t.refreshToken })).status).toBe(200);
      expect((await app.request("/v1/account", { headers: authed(t.accessToken) })).status).toBe(200);
    }
  });

  it("bounds the extra tokens in the grace window: one repeat too many counts as reuse", async () => {
    const s = await signIn(app);
    const first = (await (await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).json()) as { refreshToken: string };
    for (let i = 0; i < 8; i++) expect((await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(200);
    expect((await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
    // A chain started from a stolen token is caught: the whole device is signed out.
    expect((await post("/v1/auth/refresh", { refreshToken: first.refreshToken })).status).toBe(401);
  });

  it("lets five refreshes that race all succeed", async () => {
    const s = await signIn(app);
    const results = await Promise.all(Array.from({ length: 5 }, () => post("/v1/auth/refresh", { refreshToken: s.refreshToken })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const tokens = (await Promise.all(results.map((r) => r.json()))) as { refreshToken: string }[];
    for (const t of tokens) expect((await post("/v1/auth/refresh", { refreshToken: t.refreshToken })).status).toBe(200);
  });

  it("keeps the user signed in when a refresh is retried after a lost response", async () => {
    const s = await signIn(app);
    expect((await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(200); // response "lost"
    const retry = await post("/v1/auth/refresh", { refreshToken: s.refreshToken });
    expect(retry.status).toBe(200);
    const next = (await retry.json()) as { refreshToken: string };
    expect((await post("/v1/auth/refresh", { refreshToken: next.refreshToken })).status).toBe(200);
  });

  it("logout revokes this device's tokens", async () => {
    const s = await signIn(app);
    const res = await app.request("/v1/auth/logout", { method: "POST", headers: authed(s.accessToken) });
    expect(res.status).toBe(204);
    expect((await app.request("/v1/account", { headers: authed(s.accessToken) })).status).toBe(401);
    expect((await post("/v1/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it("rejects requests without a token", async () => {
    const res = await app.request("/v1/account");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("lists and revokes devices", async () => {
    const sub = `apple-${randomUUID()}`;
    const a = await signIn(app, sub);
    const b = await signIn(app, sub);
    const list = (await (await app.request("/v1/account/devices", { headers: authed(a.accessToken) })).json()) as {
      devices: { id: string }[];
    };
    expect(list.devices.map((d) => d.id).sort()).toEqual([a.deviceId, b.deviceId].sort());
    const del = await app.request(`/v1/account/devices/${b.deviceId}`, { method: "DELETE", headers: authed(a.accessToken) });
    expect(del.status).toBe(204);
    expect((await app.request("/v1/account", { headers: authed(b.accessToken) })).status).toBe(401);
  });
});

describe("app version", () => {
  it("returns 403 for builds below the minimum", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/defaults.js");
    const { app: strict } = makeApp({ config: { ...DEFAULT_CONFIG, minAppVersion: "2.0.0" } });
    const res = await strict.request("/v1/config", { headers: { "x-keel-app-version": "1.9.3" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("app_too_old");
  });
});

describe("config", () => {
  it("serves an ETag and honours If-None-Match", async () => {
    const res = await app.request("/v1/config");
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.taskProfiles).toBeDefined();
    expect(body.toolAllowlist).toBeUndefined();
    const again = await app.request("/v1/config", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });
});
