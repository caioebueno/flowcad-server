import { randomUUID, createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { parseJson } from "../util/validate.js";
import { log } from "../logger.js";
import {
  MAX_CHANGES,
  PushBody,
  Sha256,
  applyMutation,
  changesSince,
  collectGarbage,
  projectJson,
  storageUsed,
} from "./sync.js";

/** A push carries at most 200 mutations of up to 256 KB each, but rarely more than a few MB. */
const MAX_PUSH_BYTES = 8 * 1024 * 1024;

const ChangesQuery = z.strictObject({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(MAX_CHANGES).default(500),
  projectId: z.uuid().optional(),
});

/** A content type the app sent, kept only when it looks like one. */
const contentTypeOf = (header: string | undefined) => {
  const t = header?.split(";")[0]?.trim().toLowerCase();
  return t && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(t) ? t : "application/octet-stream";
};

/**
 * Projects synced between a person's devices: JSON records through
 * /sync/push and /sync/changes, bytes through /blobs. See docs/project-sync.md.
 */
export function projectRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { blobs: store, storage } = deps;

  app.get("/projects", async (c) => {
    const { accountId } = c.get("auth");
    const rows = await deps.sql`
      select * from projects where account_id = ${accountId} and deleted_at is null order by updated_at desc`;
    return c.json({ projects: rows.map((r) => projectJson(r as never)) });
  });

  app.get("/sync/changes", async (c) => {
    const parsed = ChangesQuery.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError(400, "invalid_request", "Invalid query");
    const { since, limit, projectId } = parsed.data;
    const { accountId } = c.get("auth");
    return c.json(await changesSince(deps.sql, accountId, since, limit, projectId));
  });

  app.post("/sync/push", async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_PUSH_BYTES) {
      throw new ApiError(413, "request_too_large", "Push fewer mutations at once", { maxBytes: MAX_PUSH_BYTES });
    }
    const body = await parseJson(c, PushBody);
    const actor = c.get("auth");
    const results = [];
    let droppedBlob = false;
    for (const m of body.mutations) {
      const result = await applyMutation(deps.sql, actor, m);
      results.push(result);
      if (result.status === "applied" && (m.deleted || m.blob !== undefined)) droppedBlob = true;
    }
    // Replaced models and deleted projects leave blobs nobody names. Clean up
    // after the response so the app isn't kept waiting.
    if (droppedBlob) {
      collectGarbage(deps.sql, store, actor.accountId).catch((err) =>
        log.warn("blob_gc_failed", { message: (err as Error).message }),
      );
    }
    return c.json({ results });
  });

  app.get("/storage", async (c) => {
    const { accountId } = c.get("auth");
    return c.json({ usedBytes: await storageUsed(deps.sql, accountId), quotaBytes: storage.quotaBytes, maxBlobBytes: storage.maxBlobBytes });
  });

  const shaParam = (raw: string) => {
    const sha = raw.toLowerCase();
    if (!Sha256.safeParse(sha).success) throw new ApiError(400, "invalid_request", "Blob id must be a sha256 in hex");
    return sha;
  };

  const blobRow = async (accountId: string, sha: string) => {
    const [row] = await deps.sql<{ size: number; content_type: string; storage_key: string }[]>`
      select size, content_type, storage_key from blobs where account_id = ${accountId} and sha256 = ${sha}`;
    return row ?? null;
  };

  app.on("HEAD", "/blobs/:sha", async (c) => {
    const row = await blobRow(c.get("auth").accountId, shaParam(c.req.param("sha")));
    if (!row) return c.body(null, 404);
    c.header("Content-Length", String(row.size));
    c.header("Content-Type", row.content_type);
    return c.body(null, 200);
  });

  app.get("/blobs/:sha", async (c) => {
    const sha = shaParam(c.req.param("sha"));
    const row = await blobRow(c.get("auth").accountId, sha);
    if (!row) throw new ApiError(404, "not_found", "No such blob");
    const stream = await store.get(row.storage_key);
    if (!stream) throw new ApiError(404, "not_found", "No such blob");
    return new Response(stream, {
      headers: {
        "Content-Type": row.content_type,
        "Content-Length": String(row.size),
        ETag: `"${sha}"`,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });

  app.put("/blobs/:sha", async (c) => {
    const sha = shaParam(c.req.param("sha"));
    const { accountId } = c.get("auth");
    const contentType = contentTypeOf(c.req.header("content-type"));
    if (await blobRow(accountId, sha)) return c.json({ sha256: sha, created: false }, 200);

    const sizeHeader = c.req.header("content-length");
    const size = sizeHeader === undefined ? NaN : Number(sizeHeader);
    if (!Number.isInteger(size) || size < 0) throw new ApiError(400, "invalid_request", "Content-Length is required");
    if (size > storage.maxBlobBytes) {
      throw new ApiError(413, "request_too_large", "File is too large", { maxBytes: storage.maxBlobBytes });
    }
    const used = await storageUsed(deps.sql, accountId);
    if (used + size > storage.quotaBytes) {
      throw new ApiError(413, "storage_full", "Project storage is full", { usedBytes: used, quotaBytes: storage.quotaBytes });
    }

    const raw = c.req.raw.body;
    const source = raw ? Readable.fromWeb(raw as never) : Readable.from([]);
    const hash = createHash("sha256");
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > size) return done(new ApiError(400, "invalid_request", "Body is longer than Content-Length"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    source.on("error", (err) => meter.destroy(err));
    source.pipe(meter);

    const key = `accounts/${accountId}/${randomUUID()}`;
    try {
      await store.put(key, meter, size, contentType);
    } catch (err) {
      await store.delete(key).catch(() => {});
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, "storage_error", "Couldn't store the file");
    }
    const digest = hash.digest("hex");
    if (seen !== size || digest !== sha) {
      await store.delete(key).catch(() => {});
      throw new ApiError(422, "hash_mismatch", "The bytes don't match the blob id", { sha256: digest, size: seen });
    }

    const [inserted] = await deps.sql`
      insert into blobs (account_id, sha256, size, content_type, storage_key)
      values (${accountId}, ${sha}, ${size}, ${contentType}, ${key})
      on conflict (account_id, sha256) do nothing
      returning 1`;
    // Another upload of the same bytes won: keep its copy.
    if (!inserted) await store.delete(key).catch(() => {});
    return c.json({ sha256: sha, created: Boolean(inserted) }, inserted ? 201 : 200);
  });

  return app;
}
