import { createHmac } from "node:crypto";
import type { Sql } from "../db/index.js";

export interface LedgerRow {
  accountId: string;
  deviceId: string;
  projectHash: string;
  threadId: string;
  runId: string;
  turnIndex: number;
  taskType: string;
  kind: "turn" | "keepwarm" | "batch";
  model: string;
  servedModel: string | null;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costMicros: number;
  stopReason: string | null;
  latencyMs: number;
  configVersion: number;
}

/** The server never stores the app's project id, only a keyed hash of it. */
export function projectHash(salt: string, accountId: string, projectId: string): string {
  return createHmac("sha256", salt).update(`${accountId}:${projectId}`).digest("hex").slice(0, 32);
}

/** First day of the UTC month containing `at`, as YYYY-MM-DD. */
export function monthOf(at = new Date()): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** Writes one ledger row and adds its cost to the month's allowance, atomically. */
export async function recordUsage(sql: Sql, row: LedgerRow, limitMicros: number): Promise<{ usedMicros: number }> {
  return sql.begin(async (tx) => {
    await tx`
      insert into usage_ledger (
        account_id, device_id, project_hash, thread_id, run_id, turn_index, task_type, kind, model, served_model,
        input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_micros, stop_reason, latency_ms, config_version
      ) values (
        ${row.accountId}, ${row.deviceId}, ${row.projectHash}, ${row.threadId}, ${row.runId}, ${row.turnIndex},
        ${row.taskType}, ${row.kind}, ${row.model}, ${row.servedModel}, ${row.inputTokens}, ${row.cacheWriteTokens},
        ${row.cacheReadTokens}, ${row.outputTokens}, ${row.costMicros}, ${row.stopReason}, ${row.latencyMs},
        ${row.configVersion}
      )`;
    const [a] = await tx<{ used_micros: number }[]>`
      insert into allowances (account_id, month, limit_micros, used_micros)
      values (${row.accountId}, ${monthOf()}, ${limitMicros}, ${row.costMicros})
      on conflict (account_id, month) do update
        set used_micros = allowances.used_micros + excluded.used_micros,
            limit_micros = excluded.limit_micros
      returning used_micros`;
    return { usedMicros: a!.used_micros };
  });
}

export async function monthUsedMicros(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ used_micros: number }[]>`
    select used_micros from allowances where account_id = ${accountId} and month = ${monthOf()}`;
  return row?.used_micros ?? 0;
}

export async function runTotals(sql: Sql, accountId: string, runId: string): Promise<{ turns: number; costMicros: number }> {
  const [row] = await sql<{ turns: number; cost: number }[]>`
    select count(*)::bigint as turns, coalesce(sum(cost_micros), 0)::bigint as cost
    from usage_ledger where account_id = ${accountId} and run_id = ${runId} and kind = 'turn'`;
  return { turns: row?.turns ?? 0, costMicros: row?.cost ?? 0 };
}
