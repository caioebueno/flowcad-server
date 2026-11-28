import { createHash } from "node:crypto";
import type { Sql } from "../db/index.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { ConfigDocSchema, type ConfigDoc } from "./schema.js";
import { log } from "../logger.js";

export interface LoadedConfig {
  /** 0 means the bundled defaults (nothing published yet). */
  version: number;
  doc: ConfigDoc;
  etag: string;
}

export interface ConfigSource {
  current(): Promise<LoadedConfig>;
}

const etagOf = (version: number, doc: ConfigDoc) =>
  `"v${version}-${createHash("sha256").update(JSON.stringify(doc)).digest("hex").slice(0, 12)}"`;

/** Settings from the environment that win over the published config. */
export interface ConfigOverrides {
  routingTiers?: boolean;
}

/** Applies environment overrides to a loaded config document. */
export function applyOverrides(doc: ConfigDoc, overrides: ConfigOverrides = {}): ConfigDoc {
  if (overrides.routingTiers === undefined) return doc;
  const routing = doc.routing ?? DEFAULT_CONFIG.routing!;
  return { ...doc, routing: { ...routing, tiers: overrides.routingTiers } };
}

export function staticConfig(doc: ConfigDoc = DEFAULT_CONFIG, version = 0): ConfigSource {
  const loaded = { version, doc, etag: etagOf(version, doc) };
  return { current: async () => loaded };
}

/** Reads the newest config version, caching it briefly so most requests skip the query. */
export class ConfigStore implements ConfigSource {
  private cached: { at: number; value: LoadedConfig } | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly ttlMs = 30_000,
    private readonly overrides: ConfigOverrides = {},
  ) {}

  async current(): Promise<LoadedConfig> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const [row] = await this.sql<{ version: number; doc: unknown }[]>`
      select version, doc from config_versions order by version desc limit 1`;
    let value: LoadedConfig;
    if (!row) {
      const doc = applyOverrides(DEFAULT_CONFIG, this.overrides);
      value = { version: 0, doc, etag: etagOf(0, doc) };
    } else {
      const parsed = ConfigDocSchema.safeParse(row.doc);
      if (!parsed.success) {
        // A bad row should never have been published (the CLI validates), but
        // never take the service down over it: keep serving the last good one.
        log.error("config_invalid", { version: row.version });
        if (this.cached) return this.cached.value;
        const doc = applyOverrides(DEFAULT_CONFIG, this.overrides);
        value = { version: 0, doc, etag: etagOf(0, doc) };
      } else {
        const doc = applyOverrides(parsed.data, this.overrides);
        value = { version: row.version, doc, etag: etagOf(row.version, doc) };
      }
    }
    this.cached = { at: Date.now(), value };
    return value;
  }

  invalidate() {
    this.cached = null;
  }
}

export async function publishConfig(sql: Sql, doc: unknown, author: string, note?: string): Promise<number> {
  const parsed = ConfigDocSchema.parse(doc);
  const [row] = await sql<{ version: number }[]>`
    insert into config_versions (doc, author, note) values (${sql.json(parsed as never)}, ${author}, ${note ?? null})
    returning version`;
  return row!.version;
}

/** Rolls back by republishing an earlier version's document as a new version. */
export async function rollbackConfig(sql: Sql, toVersion: number, author: string): Promise<number> {
  const [row] = await sql<{ doc: unknown }[]>`select doc from config_versions where version = ${toVersion}`;
  if (!row) throw new Error(`No config version ${toVersion}`);
  return publishConfig(sql, row.doc, author, `rollback to v${toVersion}`);
}
