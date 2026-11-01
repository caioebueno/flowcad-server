import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type Sql = postgres.Sql;

export function connect(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    // bigint columns (cost_micros) come back as JS numbers. Micro-dollar totals
    // stay far below 2^53, so this is safe and keeps the code simple.
    types: {
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
    transform: { undefined: null },
    onnotice: () => {},
  });
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Any fixed number; every instance takes the same lock so only one migrates at a time. */
const MIGRATION_LOCK = 7_274_801;

/**
 * Applies every migrations/*.sql file not yet recorded, in name order, each in
 * its own transaction. Safe to run from several instances at once: each file
 * runs under an advisory lock and is skipped if another instance applied it.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  });
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      const [done] = await tx`select 1 from schema_migrations where name = ${file}`;
      if (done) return false;
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
      return true;
    });
    if (applied) ran.push(file);
  }
  return ran;
}

/** Names of applied migrations, for the health check. */
export async function appliedMigrations(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select name from schema_migrations order by name`.catch(() => [] as { name: string }[]);
  return rows.map((r) => r.name);
}
