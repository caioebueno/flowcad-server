import { z } from "zod";
import type postgres from "postgres";
import type { Sql } from "../db/index.js";

type Tx = postgres.TransactionSql;
import type { BlobStore } from "../storage/blobStore.js";
import { log } from "../logger.js";

/** What lives inside a project. Each is a set of records keyed by id. */
export const COLLECTIONS = ["thread", "message", "document", "context", "file", "output", "export", "version"] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** JSON in a record or a project's data. Bigger content goes in a blob. */
export const MAX_DATA_BYTES = 256 * 1024;
export const MAX_MUTATIONS = 200;
export const MAX_CHANGES = 1000;
/** Unreferenced blobs younger than this are kept: the record naming them may not be pushed yet. */
export const BLOB_GRACE_MS = 60 * 60 * 1000;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RecordId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

const fitsInRecord = (v: unknown) => v === undefined || JSON.stringify(v).length <= MAX_DATA_BYTES;
const Data = z.record(z.string(), z.unknown()).refine(fitsInRecord, { message: "data_too_large" });

const ProjectMutation = z.strictObject({
  type: z.literal("project"),
  id: z.uuid(),
  /** The revision the device last saw; 0 to create. Absent: last writer wins. */
  baseRevision: z.number().int().nonnegative().optional(),
  name: z.string().max(500).optional(),
  data: Data.optional(),
  blob: Sha256.nullable().optional(),
  deleted: z.boolean().optional(),
});

const RecordMutation = z.strictObject({
  type: z.literal("record"),
  projectId: z.uuid(),
  collection: z.enum(COLLECTIONS),
  id: RecordId,
  baseRevision: z.number().int().nonnegative().optional(),
  data: Data.optional(),
  blob: Sha256.nullable().optional(),
  deleted: z.boolean().optional(),
});

export const Mutation = z.discriminatedUnion("type", [ProjectMutation, RecordMutation]);
export type Mutation = z.infer<typeof Mutation>;
export const PushBody = z.strictObject({ mutations: z.array(Mutation).min(1).max(MAX_MUTATIONS) });

interface ProjectRow {
  id: string;
  account_id: string;
  revision: number;
  seq: number;
  name: string;
  data: Record<string, unknown>;
  blob_sha256: string | null;
  device_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface RecordRow {
  project_id: string;
  collection: string;
  id: string;
  account_id: string;
  revision: number;
  seq: number;
  data: Record<string, unknown> | null;
  blob_sha256: string | null;
  device_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export function projectJson(r: ProjectRow) {
  return {
    type: "project" as const,
    id: r.id,
    revision: r.revision,
    seq: r.seq,
    name: r.name,
    data: r.data,
    blob: r.blob_sha256,
    deleted: r.deleted_at !== null,
    deviceId: r.device_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export function recordJson(r: RecordRow) {
  return {
    type: "record" as const,
    projectId: r.project_id,
    collection: r.collection,
    id: r.id,
    revision: r.revision,
    seq: r.seq,
    data: r.data,
    blob: r.blob_sha256,
    deleted: r.deleted_at !== null,
    deviceId: r.device_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export type Change = ReturnType<typeof projectJson> | ReturnType<typeof recordJson>;

export type MutationResult =
  | { status: "applied"; change: Change }
  | { status: "conflict"; current: Change | null }
  | { status: "error"; code: "not_found" | "project_deleted" | "blob_missing" };

interface Actor {
  accountId: string;
  deviceId: string;
}

/**
 * Takes the account's next change number. The row lock it holds until commit
 * puts every write for one account in a line, so changes commit in seq order
 * and a device reading "after N" never skips one that commits later.
 */
async function nextSeq(tx: Tx, accountId: string): Promise<number> {
  const [row] = await tx<{ seq: number }[]>`
    insert into sync_cursors (account_id, seq) values (${accountId}, 1)
    on conflict (account_id) do update set seq = sync_cursors.seq + 1
    returning seq`;
  return row!.seq;
}

async function blobExists(tx: Tx, accountId: string, sha: string) {
  const [row] = await tx`select 1 from blobs where account_id = ${accountId} and sha256 = ${sha}`;
  return Boolean(row);
}

/** Applies one mutation in its own transaction. A conflict or error leaves everything as it was. */
export async function applyMutation(sql: Sql, actor: Actor, m: Mutation): Promise<MutationResult> {
  return (await sql.begin(async (tx) => {
    const seq = await nextSeq(tx, actor.accountId);
    const result = m.type === "project" ? await applyProject(tx, actor, m, seq) : await applyRecord(tx, actor, m, seq);
    // Roll back the seq bump too, so a refused mutation leaves no gap-filling write behind.
    if (result.status !== "applied") throw new Refused(result);
    return result;
  }).catch((err) => {
    if (err instanceof Refused) return err.result;
    throw err;
  })) as MutationResult;
}

class Refused {
  constructor(readonly result: MutationResult) {}
}

async function applyProject(
  tx: Tx,
  actor: Actor,
  m: z.infer<typeof ProjectMutation>,
  seq: number,
): Promise<MutationResult> {
  const [row] = await tx<ProjectRow[]>`select * from projects where id = ${m.id} for update`;
  if (row && row.account_id !== actor.accountId) return { status: "error", code: "not_found" };
  if (m.blob && !(await blobExists(tx, actor.accountId, m.blob))) return { status: "error", code: "blob_missing" };

  if (!row) {
    if (m.baseRevision !== undefined && m.baseRevision !== 0) return { status: "conflict", current: null };
    if (m.deleted) return { status: "error", code: "not_found" };
    const [created] = await tx<ProjectRow[]>`
      insert into projects (id, account_id, revision, seq, name, data, blob_sha256, device_id)
      values (${m.id}, ${actor.accountId}, 1, ${seq}, ${m.name ?? ""}, ${tx.json((m.data ?? {}) as never)},
              ${m.blob ?? null}, ${actor.deviceId})
      returning *`;
    return { status: "applied", change: projectJson(created!) };
  }

  if (m.baseRevision !== undefined && m.baseRevision !== row.revision) {
    return { status: "conflict", current: projectJson(row) };
  }
  if (row.deleted_at && m.deleted === undefined) {
    // Writes to a deleted project need an explicit undelete (deleted: false).
    return { status: "error", code: "project_deleted" };
  }

  const deleting = m.deleted === true;
  const [updated] = await tx<ProjectRow[]>`
    update projects set
      revision = revision + 1,
      seq = ${seq},
      name = ${m.name ?? row.name},
      data = ${tx.json((m.data ?? row.data) as never)},
      blob_sha256 = ${m.blob === undefined ? row.blob_sha256 : m.blob},
      device_id = ${actor.deviceId},
      updated_at = now(),
      deleted_at = ${deleting ? (row.deleted_at ?? new Date()) : null}
    where id = ${m.id}
    returning *`;
  // A deleted project keeps only its tombstone; devices drop the whole project when they see it.
  if (deleting) await tx`delete from project_records where project_id = ${m.id}`;
  return { status: "applied", change: projectJson(updated!) };
}

async function applyRecord(
  tx: Tx,
  actor: Actor,
  m: z.infer<typeof RecordMutation>,
  seq: number,
): Promise<MutationResult> {
  const [project] = await tx<{ account_id: string; deleted_at: Date | null }[]>`
    select account_id, deleted_at from projects where id = ${m.projectId} for share`;
  if (!project || project.account_id !== actor.accountId) return { status: "error", code: "not_found" };
  if (project.deleted_at) return { status: "error", code: "project_deleted" };
  if (m.blob && !(await blobExists(tx, actor.accountId, m.blob))) return { status: "error", code: "blob_missing" };

  const [row] = await tx<RecordRow[]>`
    select * from project_records
    where project_id = ${m.projectId} and collection = ${m.collection} and id = ${m.id} for update`;

  if (!row) {
    if (m.baseRevision !== undefined && m.baseRevision !== 0) return { status: "conflict", current: null };
    if (m.deleted) return { status: "error", code: "not_found" };
    const [created] = await tx<RecordRow[]>`
      insert into project_records (project_id, collection, id, account_id, revision, seq, data, blob_sha256, device_id)
      values (${m.projectId}, ${m.collection}, ${m.id}, ${actor.accountId}, 1, ${seq},
              ${tx.json((m.data ?? {}) as never)}, ${m.blob ?? null}, ${actor.deviceId})
      returning *`;
    await touchProject(tx, m.projectId);
    return { status: "applied", change: recordJson(created!) };
  }

  // Creating over a tombstone (baseRevision 0) brings the record back.
  const recreating = row.deleted_at !== null && m.baseRevision === 0 && !m.deleted;
  if (m.baseRevision !== undefined && m.baseRevision !== row.revision && !recreating) {
    return { status: "conflict", current: recordJson(row) };
  }

  const deleting = m.deleted === true;
  const data = deleting ? null : (m.data ?? (row.deleted_at ? {} : row.data) ?? {});
  const blob = deleting ? null : m.blob === undefined ? (row.deleted_at ? null : row.blob_sha256) : m.blob;
  const [updated] = await tx<RecordRow[]>`
    update project_records set
      revision = revision + 1,
      seq = ${seq},
      data = ${data === null ? null : tx.json(data as never)},
      blob_sha256 = ${blob},
      device_id = ${actor.deviceId},
      updated_at = now(),
      deleted_at = ${deleting ? (row.deleted_at ?? new Date()) : null}
    where project_id = ${m.projectId} and collection = ${m.collection} and id = ${m.id}
    returning *`;
  await touchProject(tx, m.projectId);
  return { status: "applied", change: recordJson(updated!) };
}

/** The project list sorts by last activity, so a record change moves its project's updated_at. */
async function touchProject(tx: Tx, projectId: string) {
  await tx`update projects set updated_at = now() where id = ${projectId}`;
}

/** Every change after `since`, in order, tombstones included. */
export async function changesSince(
  sql: Sql,
  accountId: string,
  since: number,
  limit: number,
  projectId?: string,
): Promise<{ changes: Change[]; cursor: number; hasMore: boolean }> {
  const projectFilter = projectId ? sql`and id = ${projectId}` : sql``;
  const recordFilter = projectId ? sql`and project_id = ${projectId}` : sql``;
  const projects = await sql<ProjectRow[]>`
    select * from projects where account_id = ${accountId} and seq > ${since} ${projectFilter}
    order by seq limit ${limit + 1}`;
  const records = await sql<RecordRow[]>`
    select * from project_records where account_id = ${accountId} and seq > ${since} ${recordFilter}
    order by seq limit ${limit + 1}`;
  const merged: Change[] = [...projects.map(projectJson), ...records.map(recordJson)].sort((a, b) => a.seq - b.seq);
  const hasMore = merged.length > limit;
  const changes = merged.slice(0, limit);
  let cursor = changes.length ? changes[changes.length - 1]!.seq : since;
  if (!hasMore && !projectId) {
    // Nothing left to read: move the cursor to the account's latest number, so
    // seqs used by refused or purged writes aren't asked for again.
    const [row] = await sql<{ seq: number }[]>`select seq from sync_cursors where account_id = ${accountId}`;
    if (row && row.seq > cursor) cursor = row.seq;
  }
  return { changes, cursor, hasMore };
}

/**
 * Deletes blobs no live project or record names, once they are past the grace
 * period. Holds the account's sync lock, so a push can't name a blob while it
 * is being removed.
 */
export async function collectGarbage(sql: Sql, store: BlobStore, accountId: string, graceMs = BLOB_GRACE_MS) {
  const keys = await sql.begin(async (tx) => {
    await tx`insert into sync_cursors (account_id) values (${accountId}) on conflict do nothing`;
    await tx`select seq from sync_cursors where account_id = ${accountId} for update`;
    const rows = await tx<{ storage_key: string }[]>`
      delete from blobs b
      where b.account_id = ${accountId}
        and b.created_at < now() - make_interval(secs => ${graceMs / 1000})
        and not exists (select 1 from project_records r where r.account_id = b.account_id and r.blob_sha256 = b.sha256)
        and not exists (select 1 from projects p where p.account_id = b.account_id and p.blob_sha256 = b.sha256
                        and p.deleted_at is null)
      returning b.storage_key`;
    return rows.map((r) => r.storage_key);
  });
  for (const key of keys) {
    await store.delete(key).catch((err) => log.warn("blob_delete_failed", { message: (err as Error).message }));
  }
  return keys.length;
}

export async function storageUsed(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ used: number }[]>`
    select coalesce(sum(size), 0)::bigint as used from blobs where account_id = ${accountId}`;
  return row?.used ?? 0;
}
