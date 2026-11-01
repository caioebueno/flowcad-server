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

/**
 * Writes one ledger row and charges its cost, atomically: first to the credit
 * period's monthly credits, then to pack credits (soonest expiry first). A turn
 * that runs past everything is still charged to the period, so the overrun
 * is counted and the next turn is refused.
 */
export async function recordUsage(
  sql: Sql,
  row: LedgerRow,
  period: { start: Date; limitMicros: number },
): Promise<{ monthlyUsedMicros: number; extraMicros: number }> {
  return sql.begin(async (tx) => {
    // Upserting first locks the period's row, so concurrent turns charge in order.
    const [a] = await tx<{ used_micros: number }[]>`
      insert into allowances (account_id, period_start, month, limit_micros, used_micros)
      values (${row.accountId}, ${period.start}, ${monthOf(period.start)}, ${period.limitMicros}, 0)
      on conflict (account_id, period_start) do update set limit_micros = excluded.limit_micros
      returning used_micros`;
    const used = a!.used_micros;
    const toMonthly = Math.min(row.costMicros, Math.max(0, period.limitMicros - used));
    let rest = row.costMicros - toMonthly;
    let fromExtra = 0;
    if (rest > 0) {
      const grants = await tx<{ id: string; remaining_micros: number }[]>`
        select id, remaining_micros from credit_grants
        where account_id = ${row.accountId} and remaining_micros > 0 and expires_at > now()
        order by expires_at, created_at for update`;
      for (const g of grants) {
        if (rest <= 0) break;
        const take = Math.min(rest, g.remaining_micros);
        await tx`update credit_grants set remaining_micros = remaining_micros - ${take} where id = ${g.id}`;
        rest -= take;
        fromExtra += take;
      }
    }
    const [updated] = await tx<{ used_micros: number }[]>`
      update allowances set used_micros = used_micros + ${toMonthly + rest}
      where account_id = ${row.accountId} and period_start = ${period.start}
      returning used_micros`;
    await tx`
      insert into usage_ledger (
        account_id, device_id, project_hash, thread_id, run_id, turn_index, task_type, kind, model, served_model,
        input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_micros, extra_micros, stop_reason,
        latency_ms, config_version
      ) values (
        ${row.accountId}, ${row.deviceId}, ${row.projectHash}, ${row.threadId}, ${row.runId}, ${row.turnIndex},
        ${row.taskType}, ${row.kind}, ${row.model}, ${row.servedModel}, ${row.inputTokens}, ${row.cacheWriteTokens},
        ${row.cacheReadTokens}, ${row.outputTokens}, ${row.costMicros}, ${fromExtra}, ${row.stopReason}, ${row.latencyMs},
        ${row.configVersion}
      )`;
    const [g] = await tx<{ remaining: number }[]>`
      select coalesce(sum(remaining_micros), 0)::bigint as remaining from credit_grants
      where account_id = ${row.accountId} and remaining_micros > 0 and expires_at > now()`;
    return { monthlyUsedMicros: updated!.used_micros, extraMicros: g?.remaining ?? 0 };
  });
}

export async function runTotals(sql: Sql, accountId: string, runId: string): Promise<{ turns: number; costMicros: number }> {
  const [row] = await sql<{ turns: number; cost: number }[]>`
    select count(*)::bigint as turns, coalesce(sum(cost_micros), 0)::bigint as cost
    from usage_ledger where account_id = ${accountId} and run_id = ${runId} and kind = 'turn'`;
  return { turns: row?.turns ?? 0, costMicros: row?.cost ?? 0 };
}
