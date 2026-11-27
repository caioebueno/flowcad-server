import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Sql } from "../db/index.js";

/**
 * Where blob bytes live. Rows in `blobs` say which account owns which hash and
 * point at a storage key here; the store only keeps bytes under keys.
 */
export interface BlobStore {
  readonly kind: "s3" | "postgres";
  /** Writes the stream under `key`. `size` is the exact byte count the stream will yield. */
  put(key: string, body: Readable, size: number, contentType: string): Promise<void>;
  /** The bytes under `key`, or null when there are none. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

/** An S3-compatible bucket: Railway Buckets, Cloudflare R2, AWS S3. */
export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  constructor(
    private readonly opts: {
      bucket: string;
      region: string;
      endpoint?: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle?: boolean;
    },
  ) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Readable, size: number, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ContentLength: size, ContentType: contentType }),
    );
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return res.Body ? (res.Body.transformToWebStream() as ReadableStream<Uint8Array>) : null;
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}

const CHUNK_BYTES = 1024 * 1024;

/**
 * Bytes in Postgres, 1 MB per row. For development, tests and small deploys
 * without a bucket; set the S3 variables in production.
 */
export class PostgresBlobStore implements BlobStore {
  readonly kind = "postgres" as const;
  constructor(private readonly sql: Sql) {}

  async put(key: string, body: Readable, _size: number) {
    let idx = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async (final: boolean) => {
      while (pendingBytes >= CHUNK_BYTES || (final && pendingBytes > 0)) {
        const all = Buffer.concat(pending);
        const chunk = all.subarray(0, CHUNK_BYTES);
        const rest = all.subarray(chunk.length);
        await this.sql`insert into blob_chunks (storage_key, idx, data) values (${key}, ${idx++}, ${chunk})`;
        pending = rest.length ? [Buffer.from(rest)] : [];
        pendingBytes = rest.length;
      }
    };
    try {
      for await (const part of body) {
        const buf = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
        pending.push(buf);
        pendingBytes += buf.length;
        if (pendingBytes >= CHUNK_BYTES) await flush(false);
      }
      await flush(true);
    } catch (err) {
      await this.delete(key).catch(() => {});
      throw err;
    }
  }

  async get(key: string) {
    const [first] = await this.sql<{ n: number }[]>`select count(*)::int as n from blob_chunks where storage_key = ${key}`;
    if (!first || first.n === 0) {
      // A zero-byte blob has no chunks; the blobs row is what says it exists.
      return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    }
    const sql = this.sql;
    let idx = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const [row] = await sql<{ data: Buffer }[]>`
          select data from blob_chunks where storage_key = ${key} and idx = ${idx}`;
        if (!row) return controller.close();
        idx++;
        controller.enqueue(new Uint8Array(row.data));
      },
    });
  }

  async delete(key: string) {
    await this.sql`delete from blob_chunks where storage_key = ${key}`;
  }
}
