import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authed, db, makeApp, signIn } from "./helpers.js";
import { collectGarbage, MAX_DATA_BYTES } from "../src/projects/sync.js";
import { PostgresBlobStore } from "../src/storage/blobStore.js";

const { app } = makeApp({ storage: { quotaBytes: 6 * 1024 * 1024, maxBlobBytes: 4 * 1024 * 1024 } });

type Json = Record<string, any>;

async function push(token: string, mutations: unknown[]) {
  const res = await app.request("/v1/sync/push", { method: "POST", headers: authed(token), body: JSON.stringify({ mutations }) });
  return { status: res.status, body: (await res.json()) as Json };
}

async function changes(token: string, query = "") {
  const res = await app.request(`/v1/sync/changes${query}`, { headers: authed(token) });
  expect(res.status).toBe(200);
  return (await res.json()) as { changes: Json[]; cursor: number; hasMore: boolean };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function upload(token: string, bytes: Uint8Array, contentType = "application/zip", id = sha(bytes)) {
  return app.request(`/v1/blobs/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, "content-length": String(bytes.length) },
    body: bytes,
  });
}

/** One person signed in on two Macs. */
async function twoDevices() {
  const mac = await signIn(app, undefined, randomUUID(), null);
  const laptop = await signIn(app, mac.sub, randomUUID(), null);
  return { mac: mac.accessToken, laptop: laptop.accessToken, accountId: mac.account.id };
}

describe("project sync", () => {
  it("syncs a project and its messages to another device, Free plan included", async () => {
    const { mac, laptop } = await twoDevices();
    const projectId = randomUUID();
    const res = await push(mac, [
      { type: "project", id: projectId, baseRevision: 0, name: "Open Pizza Machine", data: { threadTitle: "Pizza", sample: false } },
      { type: "record", projectId, collection: "thread", id: "t1", baseRevision: 0, data: { title: "Pizza" } },
      { type: "record", projectId, collection: "message", id: "m1", data: { threadId: "t1", role: "user", text: "Build a pizza press" } },
      { type: "record", projectId, collection: "message", id: "m2", data: { threadId: "t1", role: "assistant", text: "Here's a plan" } },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: Json) => r.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(res.body.results[0].change).toMatchObject({ type: "project", id: projectId, revision: 1, name: "Open Pizza Machine" });

    const feed = await changes(laptop, "?since=0");
    expect(feed.hasMore).toBe(false);
    expect(feed.changes.map((c) => c.type === "project" ? "project" : `${c.collection}/${c.id}`)).toEqual([
      "project",
      "thread/t1",
      "message/m1",
      "message/m2",
    ]);
    expect(feed.changes[2]).toMatchObject({ projectId, data: { text: "Build a pizza press" }, deleted: false });

    // Nothing new after the cursor; a later change shows up on its own.
    expect((await changes(laptop, `?since=${feed.cursor}`)).changes).toEqual([]);
    await push(laptop, [{ type: "record", projectId, collection: "message", id: "m3", data: { text: "Make it shorter" } }]);
    const next = await changes(mac, `?since=${feed.cursor}`);
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0]).toMatchObject({ collection: "message", id: "m3" });
    expect(next.cursor).toBeGreaterThan(feed.cursor);

    const list = await app.request("/v1/projects", { headers: authed(laptop) });
    expect(((await list.json()) as Json).projects.map((p: Json) => p.id)).toEqual([projectId]);
  });

  it("returns a conflict with the server copy when the base revision is stale", async () => {
    const { mac, laptop } = await twoDevices();
    const projectId = randomUUID();
    await push(mac, [{ type: "project", id: projectId, baseRevision: 0, name: "Shelf" }]);
    await push(mac, [{ type: "record", projectId, collection: "context", id: "brief", baseRevision: 0, data: { text: "v1" } }]);

    const first = await push(mac, [{ type: "record", projectId, collection: "context", id: "brief", baseRevision: 1, data: { text: "mac" } }]);
    expect(first.body.results[0]).toMatchObject({ status: "applied", change: { revision: 2 } });
    const stale = await push(laptop, [{ type: "record", projectId, collection: "context", id: "brief", baseRevision: 1, data: { text: "laptop" } }]);
    expect(stale.body.results[0]).toMatchObject({ status: "conflict", current: { revision: 2, data: { text: "mac" } } });

    // Creating something that already exists is a conflict too.
    const dup = await push(laptop, [{ type: "project", id: projectId, baseRevision: 0, name: "Other" }]);
    expect(dup.body.results[0]).toMatchObject({ status: "conflict", current: { name: "Shelf" } });

    // Without a base revision the last writer wins.
    const lww = await push(laptop, [{ type: "record", projectId, collection: "context", id: "brief", data: { text: "laptop" } }]);
    expect(lww.body.results[0]).toMatchObject({ status: "applied", change: { revision: 3, data: { text: "laptop" } } });
  });

  it("keeps accounts apart", async () => {
    const owner = await signIn(app, undefined, randomUUID(), null);
    const other = await signIn(app, undefined, randomUUID(), null);
    const projectId = randomUUID();
    await push(owner.accessToken, [{ type: "project", id: projectId, baseRevision: 0, name: "Mine" }]);

    const write = await push(other.accessToken, [
      { type: "project", id: projectId, name: "Stolen" },
      { type: "record", projectId, collection: "message", id: "x", data: { text: "hi" } },
    ]);
    expect(write.body.results).toEqual([
      { status: "error", code: "not_found" },
      { status: "error", code: "not_found" },
    ]);
    expect((await changes(other.accessToken, "?since=0")).changes).toEqual([]);
    expect((await changes(other.accessToken, `?since=0&projectId=${projectId}`)).changes).toEqual([]);

    const bytes = randomBytes(100);
    expect((await upload(owner.accessToken, bytes)).status).toBe(201);
    const peek = await app.request(`/v1/blobs/${sha(bytes)}`, { headers: authed(other.accessToken) });
    expect(peek.status).toBe(404);
    const use = await push(other.accessToken, [{ type: "project", id: randomUUID(), name: "x", blob: sha(bytes) }]);
    expect(use.body.results[0]).toEqual({ status: "error", code: "blob_missing" });
  });

  it("deletes a project to a tombstone, refuses writes to it, and can bring it back", async () => {
    const { mac, laptop } = await twoDevices();
    const projectId = randomUUID();
    await push(mac, [
      { type: "project", id: projectId, baseRevision: 0, name: "Slider" },
      { type: "record", projectId, collection: "output", id: "bom", data: { lines: 27 } },
    ]);
    const { cursor } = await changes(laptop, "?since=0");

    const del = await push(mac, [{ type: "project", id: projectId, deleted: true }]);
    expect(del.body.results[0]).toMatchObject({ status: "applied", change: { deleted: true, revision: 2 } });
    const feed = await changes(laptop, `?since=${cursor}`);
    expect(feed.changes).toEqual([expect.objectContaining({ type: "project", id: projectId, deleted: true })]);
    const [{ n }] = (await db()`select count(*)::int as n from project_records where project_id = ${projectId}`) as any;
    expect(n).toBe(0);

    const late = await push(laptop, [
      { type: "record", projectId, collection: "message", id: "m", data: {} },
      { type: "project", id: projectId, name: "Renamed" },
    ]);
    expect(late.body.results.map((r: Json) => r.code)).toEqual(["project_deleted", "project_deleted"]);
    const list = (await (await app.request("/v1/projects", { headers: authed(mac) })).json()) as Json;
    expect(list.projects.find((p: Json) => p.id === projectId)).toBeUndefined();

    const back = await push(laptop, [{ type: "project", id: projectId, deleted: false, name: "Slider" }]);
    expect(back.body.results[0]).toMatchObject({ status: "applied", change: { deleted: false, revision: 3 } });
  });

  it("deletes a record to a tombstone and recreates it with base revision 0", async () => {
    const { mac } = await twoDevices();
    const projectId = randomUUID();
    await push(mac, [
      { type: "project", id: projectId, baseRevision: 0, name: "Clip" },
      { type: "record", projectId, collection: "export", id: "e1", baseRevision: 0, data: { kind: "stl" } },
    ]);
    const gone = await push(mac, [{ type: "record", projectId, collection: "export", id: "e1", baseRevision: 1, deleted: true }]);
    expect(gone.body.results[0]).toMatchObject({ status: "applied", change: { deleted: true, data: null } });
    const again = await push(mac, [{ type: "record", projectId, collection: "export", id: "e1", baseRevision: 0, data: { kind: "3mf" } }]);
    expect(again.body.results[0]).toMatchObject({ status: "applied", change: { deleted: false, revision: 3, data: { kind: "3mf" } } });
  });

  it("pages through changes", async () => {
    const { mac, laptop } = await twoDevices();
    const projectId = randomUUID();
    const messages = Array.from({ length: 7 }, (_, i) => ({ type: "record", projectId, collection: "message", id: `m${i}`, data: { i } }));
    await push(mac, [{ type: "project", id: projectId, baseRevision: 0, name: "Long" }, ...messages]);

    const seen: Json[] = [];
    let since = 0;
    for (let page = 0; page < 10; page++) {
      const res = await changes(laptop, `?since=${since}&limit=3`);
      seen.push(...res.changes);
      since = res.cursor;
      if (!res.hasMore) break;
    }
    expect(seen).toHaveLength(8);
    expect(seen.map((c) => c.seq)).toEqual([...seen.map((c) => c.seq)].sort((a, b) => a - b));
  });

  it("rejects bad mutations", async () => {
    const { mac } = await twoDevices();
    const projectId = randomUUID();
    await push(mac, [{ type: "project", id: projectId, baseRevision: 0, name: "x" }]);
    const big = await push(mac, [
      { type: "record", projectId, collection: "message", id: "big", data: { text: "x".repeat(MAX_DATA_BYTES) } },
    ]);
    expect(big.status).toBe(400);
    const badCollection = await push(mac, [{ type: "record", projectId, collection: "secrets", id: "a", data: {} }]);
    expect(badCollection.status).toBe(400);
    const noAuth = await app.request("/v1/sync/changes");
    expect(noAuth.status).toBe(401);
  });
});

describe("project files", () => {
  it("uploads, dedupes, serves and links a model package", async () => {
    const { mac, laptop } = await twoDevices();
    // Bigger than one 1 MB chunk, to cover chunking.
    const bytes = randomBytes(2_500_000);
    const id = sha(bytes);

    expect((await app.request(`/v1/blobs/${id}`, { method: "HEAD", headers: authed(mac) })).status).toBe(404);
    const put = await upload(mac, bytes);
    expect(put.status).toBe(201);
    expect((await upload(laptop, bytes)).status).toBe(200);

    const head = await app.request(`/v1/blobs/${id}`, { method: "HEAD", headers: authed(laptop) });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));

    const got = await app.request(`/v1/blobs/${id}`, { headers: authed(laptop) });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);

    const projectId = randomUUID();
    const res = await push(mac, [
      { type: "project", id: projectId, baseRevision: 0, name: "Pizza" },
      { type: "record", projectId, collection: "document", id: "model", baseRevision: 0, data: { format: "keel-package-zip" }, blob: id },
      { type: "record", projectId, collection: "file", id: "photo", data: { name: "bench.jpg" }, blob: "0".repeat(64) },
    ]);
    expect(res.body.results[0].status).toBe("applied");
    expect(res.body.results[1]).toMatchObject({ status: "applied", change: { blob: id } });
    expect(res.body.results[2]).toEqual({ status: "error", code: "blob_missing" });

    const storage = (await (await app.request("/v1/storage", { headers: authed(mac) })).json()) as Json;
    expect(storage.usedBytes).toBe(bytes.length);
  });

  it("refuses bytes that don't match their id, oversize files and a full quota", async () => {
    const { mac } = await twoDevices();
    const bytes = randomBytes(1000);
    const wrong = await upload(mac, bytes, "image/jpeg", sha(randomBytes(10)));
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as Json).error.code).toBe("hash_mismatch");
    const [{ n }] = (await db()`select count(*)::int as n from blobs where sha256 = ${sha(bytes)}`) as any;
    expect(n).toBe(0);

    expect((await upload(mac, randomBytes(4 * 1024 * 1024 + 1))).status).toBe(413);

    expect((await upload(mac, randomBytes(3 * 1024 * 1024))).status).toBe(201);
    expect((await upload(mac, randomBytes(3 * 1024 * 1024))).status).toBe(201);
    const full = await upload(mac, randomBytes(1024));
    expect(full.status).toBe(413);
    expect(((await full.json()) as Json).error.code).toBe("storage_full");
  });

  it("garbage-collects blobs no project or record names", async () => {
    const { mac, accountId } = await twoDevices();
    const kept = randomBytes(300);
    const replaced = randomBytes(300);
    await upload(mac, kept);
    await upload(mac, replaced);
    const projectId = randomUUID();
    await push(mac, [
      { type: "project", id: projectId, baseRevision: 0, name: "GC" },
      { type: "record", projectId, collection: "document", id: "model", data: {}, blob: sha(replaced) },
    ]);
    await push(mac, [{ type: "record", projectId, collection: "document", id: "model", data: {}, blob: sha(kept) }]);

    const store = new PostgresBlobStore(db());
    expect(await collectGarbage(db(), store, accountId)).toBe(0); // still inside the grace period
    expect(await collectGarbage(db(), store, accountId, 0)).toBe(1);
    const rows = await db()`select sha256 from blobs where account_id = ${accountId}`;
    expect(rows.map((r) => r.sha256)).toEqual([sha(kept)]);
    expect((await app.request(`/v1/blobs/${sha(replaced)}`, { headers: authed(mac) })).status).toBe(404);

    // Deleting the project frees the rest.
    await push(mac, [{ type: "project", id: projectId, deleted: true }]);
    expect(await collectGarbage(db(), store, accountId, 0)).toBe(1);
    const [{ n }] = (await db()`select count(*)::int as n from blob_chunks where storage_key like ${`accounts/${accountId}/%`}`) as any;
    expect(n).toBe(0);
  });
});
