# Project sync

Keel Make keeps projects the way the Claude app keeps chats: the person never
manages project files, and every project shows up on each Mac they sign in on.
The server holds the copy of record; the app's folder under
`~/Library/Application Support/Keel/Projects/<uuid>/` is a cache of it that
works offline and pushes its changes when it can.

All routes are under `/v1`, need the device's access token, and work on every
plan (Free included: outputs, exports and the editor stay free).

## What is stored

| Thing | Where | Shape |
| --- | --- | --- |
| Project | `projects` row | `id` (the app's uuid), `name`, `data` (any JSON: `threadTitle`, `sample`, `kind`, subtitle numbers…), `blob` (thumbnail, optional) |
| Everything inside it | `project_records` rows, keyed by `(collection, id)` | `data` (JSON, at most 256 KB) and an optional `blob` |
| Bytes | `blobs` (owner, size, type) plus the bucket | Addressed by sha256 of the bytes, per account |

Collections and what goes in them:

| Collection | Suggested use |
| --- | --- |
| `thread` | One per chat thread: `{ title, created }` |
| `message` | One per message: `{ threadId, role, text, data, created }`. Messages are append-only, so push them without a base revision |
| `document` | The model. `id: "model"`, `blob` = sha256 of the zipped `model.keel` package, `data: { format: "keel-package-zip", infoVersion }`. Parts and assemblies stay inside the package |
| `context` | The brief and other context: `id: "brief"`, `data: { text, units, currency, workshop… }` |
| `file` | One per uploaded photo, sketch, datasheet or STEP: `data: { name, kind, addedAt }`, `blob` = the file |
| `output` | `parts`, `bom`, `cut`, `print`, `steps`: the last computed output as JSON, so another Mac can show it before it recomputes. Rendered pages can be a blob |
| `export` | One per export the person made (Build Pack PDF, STL, 3MF, CSV): `data: { name, kind, createdAt }`, `blob` = the file |
| `version` | One per version (v1, v2…): `data: { label, sentence, createdAt }`, `blob` = that version's model zip, which keeps it from being cleaned up |

### The model package

`model.keel` (Info.json + document.sqlite) is synced as one opaque blob: zip the
package and upload the zip. Before zipping, fold the WAL into the database
(`PRAGMA wal_checkpoint(TRUNCATE)` with no writer open, or copy it out with
SQLite's backup API) so the zip is a consistent snapshot. Upload it when the
model has been idle for about 30 seconds, on closing the project and on quit, not
on every 3-second autosave: each upload is a new blob, and old ones are only
removed an hour after nothing names them.

## Blobs

```
HEAD /v1/blobs/<sha256>   200 with Content-Length if the account has it, else 404
PUT  /v1/blobs/<sha256>   raw bytes; Content-Length and Content-Type required
GET  /v1/blobs/<sha256>   the bytes, immutable (cache forever)
GET  /v1/storage          { usedBytes, quotaBytes, maxBlobBytes }
```

`PUT` answers `201 { sha256, created: true }`, or `200 { created: false }` when the
account already has those bytes (so a second Mac never uploads the same file twice).
Errors: `413 request_too_large` (over `maxBlobBytes`, 512 MB by default),
`413 storage_full` (over the account's quota, 5 GB by default, with `usedBytes` and
`quotaBytes`), `422 hash_mismatch` (the bytes don't hash to the id).

Upload a blob before pushing the record that names it, or that mutation comes back
`blob_missing`.

## Pushing changes

```
POST /v1/sync/push
{ "mutations": [
  { "type": "project", "id": "<uuid>", "baseRevision": 0, "name": "Open Pizza Machine", "data": { … } },
  { "type": "record", "projectId": "<uuid>", "collection": "message", "id": "<uuid>", "data": { … } },
  { "type": "record", "projectId": "<uuid>", "collection": "document", "id": "model", "baseRevision": 4,
    "data": { "format": "keel-package-zip" }, "blob": "<sha256>" }
] }
```

- 1 to 200 mutations, applied in order, each on its own. The body may be up to 8 MB.
- `baseRevision` is the revision this device last saw: `0` to create. If the server
  has moved on, that mutation is a conflict and nothing changes. Leave it out for
  last-writer-wins.
- Omitted `name`, `data` or `blob` keep the server's value; `blob: null` clears it.
- `deleted: true` deletes. A deleted record keeps a tombstone so other devices hear
  about it; a deleted project keeps only its tombstone (its records are removed).
  Writes to a deleted project answer `project_deleted` until a project mutation with
  `deleted: false` brings it back. Pushing a record with `baseRevision: 0` over its
  tombstone recreates it.

The answer has one result per mutation, in order:

```json
{ "results": [
  { "status": "applied", "change": { "type": "project", "id": "…", "revision": 1, "seq": 812, … } },
  { "status": "conflict", "current": { "type": "record", "revision": 5, "data": { … }, … } },
  { "status": "error", "code": "blob_missing" }
] }
```

Error codes: `not_found` (no such project for this account), `project_deleted`,
`blob_missing`. `current` is `null` when the device expected a row that doesn't exist.

On a conflict, take `current` as the new local copy and redo the change on top if it
still makes sense. JSON records (the brief, outputs) can usually be merged field by
field. The model can't be merged: keep the server's model and save the local one as a
`version` record ("Changes from MacBook Air"), so nothing is lost.

## Pulling changes

```
GET /v1/sync/changes?since=<cursor>&limit=500[&projectId=<uuid>]
→ { "changes": [ …project and record rows, oldest first… ], "cursor": 830, "hasMore": false }
```

- Every write for an account takes the next number in one sequence (`seq`). A device
  stores the `cursor` it last got and asks for everything after it. A brand-new Mac
  starts at `since=0`.
- While `hasMore` is true, ask again with the new cursor. `limit` is at most 1,000.
- Rows include tombstones (`deleted: true`). A deleted project means: remove its
  local folder.
- Rows that came from this device (`deviceId` matches) can be skipped.
- With `projectId`, only that project and its records come back (useful to open a
  project fully on first sight); keep the account-wide cursor for regular pulls.
- Poll on launch, when the app becomes active, after each push, and about every 30
  seconds while a project is open.

`GET /v1/projects` lists the account's live projects, most recently changed first,
for the sidebar before a full pull has finished.

## Storage on the server

- Postgres holds projects, records and blob metadata. Blob bytes go to an
  S3-compatible bucket when `S3_BUCKET` is set (Railway Buckets, Cloudflare R2 or
  AWS S3; `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), and
  to the `blob_chunks` table otherwise (fine locally, not for production).
- After a push that replaces or removes a blob reference, the server deletes blobs no
  live project or record names, once they are an hour old.
- Deleting an account removes its projects, records and blob rows (cascade). Objects
  in the bucket are not removed with it yet.

## Not in this version

- Push notifications between devices (pull on a timer and on focus for now).
- Sharing a project with another account or as a public page.
- Signed direct-to-bucket upload URLs (bytes go through the server).
- Per-plan storage quotas (one quota for every account, from `STORAGE_QUOTA_BYTES`).
