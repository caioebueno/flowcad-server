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
  /** The in-flight row `reserveTurn` wrote for this turn; it is replaced by the real one. */
  reservationId: number | null = null,
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
    const [settled] = reservationId
      ? await tx`
          update usage_ledger set
            device_id = ${row.deviceId}, model = ${row.model}, served_model = ${row.servedModel},
            input_tokens = ${row.inputTokens}, cache_write_tokens = ${row.cacheWriteTokens},
            cache_read_tokens = ${row.cacheReadTokens}, output_tokens = ${row.outputTokens},
            cost_micros = ${row.costMicros}, extra_micros = ${fromExtra}, stop_reason = ${row.stopReason},
            latency_ms = ${row.latencyMs}, config_version = ${row.configVersion}
          where id = ${reservationId} and account_id = ${row.accountId} and stop_reason = ${IN_FLIGHT}
          returning id`
      : [];
    if (!settled) {
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
    }
    const [g] = await tx<{ remaining: number }[]>`
      select coalesce(sum(remaining_micros), 0)::bigint as remaining from credit_grants
      where account_id = ${row.accountId} and remaining_micros > 0 and expires_at > now()`;
    return { monthlyUsedMicros: updated!.used_micros, extraMicros: g?.remaining ?? 0 };
  });
}

/**
 * A turn that is still streaming is a ledger row with this stop reason. Its
 * `cost_micros` holds what the turn could cost at most, which is held back
 * from the balance until the turn ends and the row is replaced by the real one.
 */
export const IN_FLIGHT = "in_flight";

/**
 * A turn in flight beats every RESERVATION_HEARTBEAT_SECONDS while it streams
 * (`heartbeatTurn`). A reservation that hasn't beaten for this long is a turn
 * the server never finished (a crash, or a deploy that killed it): it stops
 * holding credits and a concurrency slot. However long a live turn streams,
 * it keeps its hold.
 */
export const RESERVATION_TTL_MINUTES = 5;
export const RESERVATION_HEARTBEAT_SECONDS = 60;

/**
 * True for an in-flight row that is still beating. An in-flight row has no
 * latency yet, so `latency_ms` holds the time of its last heartbeat, counted
 * from `created_at` (which stays the start of the turn for /usage and rates).
 */
const liveHold = (sql: Sql) =>
  sql`created_at + make_interval(secs => latency_ms / 1000.0) > now() - make_interval(mins => ${RESERVATION_TTL_MINUTES})`;

/** Turns that never produced a reply don't use up a run. */
const NOT_A_TURN = ["upstream_error", "client_disconnected"];

export async function runTotals(sql: Sql, accountId: string, runId: string): Promise<{ turns: number; costMicros: number }> {
  const [row] = await sql<{ turns: number; cost: number }[]>`
    select
      count(*) filter (where stop_reason is null or stop_reason <> all(${NOT_A_TURN}))::bigint as turns,
      coalesce(sum(cost_micros) filter (where stop_reason is distinct from ${IN_FLIGHT}), 0)::bigint as cost
    from usage_ledger
    where account_id = ${accountId} and run_id = ${runId} and kind = 'turn'
      and (stop_reason is distinct from ${IN_FLIGHT} or ${liveHold(sql)})`;
  return { turns: row?.turns ?? 0, costMicros: row?.cost ?? 0 };
}

export type Reservation =
  | { ok: true; id: number; run: { turns: number; costMicros: number } }
  | { ok: false; reason: "credits_exhausted" }
  | { ok: false; reason: "credits_held" | "too_many_in_flight" | "too_many_per_minute" }
  | { ok: false; reason: "run_limit_reached"; limit: "turns" | "cost" };

/**
 * Admits a turn and holds back what it could cost, or says why not. Runs under
 * a lock on the account row, so turns sent at the same time are admitted one
 * after another and each one sees the others' reservations:
 *
 * - credits: what is left (monthly plus packs) minus what turns in flight hold
 *   must be above zero. The last turn of a period can still run past the end,
 *   as before, but only one turn can, not any number sent at once. When there
 *   are credits but turns in flight hold them all, the answer is "credits_held"
 *   (try again shortly), not "credits_exhausted";
 * - concurrency: at most `limits.concurrentRuns` turns in flight per account;
 * - rate: at most `limits.turnsPerMinute` turns and keepwarms started a minute
 *   per account;
 * - run caps (turns only): turns in flight count toward the run's turn cap.
 *
 * Keepwarms go through here too (`kind: "keepwarm"`): a prewarm writes the
 * whole request to the cache, so it costs real money.
 */
export async function reserveTurn(
  sql: Sql,
  row: Pick<LedgerRow, "accountId" | "deviceId" | "projectHash" | "threadId" | "runId" | "turnIndex" | "taskType" | "model" | "configVersion">,
  reserveMicros: number,
  period: { start: Date; limitMicros: number },
  limits: { concurrentRuns: number; turnsPerMinute: number; maxTurnsPerRun: number; maxCostPerRunMicros: number },
  kind: "turn" | "keepwarm" = "turn",
): Promise<Reservation> {
  return sql.begin(async (tx) => {
    await tx`select id from accounts where id = ${row.accountId} for update`;
    const [held] = await tx<{ n: number; micros: number }[]>`
      select count(*)::bigint as n, coalesce(sum(cost_micros), 0)::bigint as micros from usage_ledger
      where account_id = ${row.accountId} and stop_reason = ${IN_FLIGHT} and ${liveHold(tx as unknown as Sql)}`;
    const [a] = await tx<{ used_micros: number }[]>`
      select used_micros from allowances where account_id = ${row.accountId} and period_start = ${period.start}`;
    const [g] = await tx<{ remaining: number }[]>`
      select coalesce(sum(remaining_micros), 0)::bigint as remaining from credit_grants
      where account_id = ${row.accountId} and remaining_micros > 0 and expires_at > now()`;
    const balance = Math.max(0, period.limitMicros - (a?.used_micros ?? 0)) + (g?.remaining ?? 0);
    if (balance <= 0) return { ok: false, reason: "credits_exhausted" } as const;
    if (balance - held!.micros <= 0) return { ok: false, reason: "credits_held" } as const;
    if (held!.n >= limits.concurrentRuns) return { ok: false, reason: "too_many_in_flight" } as const;
    const [recent] = await tx<{ n: number }[]>`
      select count(*)::bigint as n from usage_ledger
      where account_id = ${row.accountId} and kind in ('turn', 'keepwarm') and created_at > now() - interval '1 minute'`;
    if (recent!.n >= limits.turnsPerMinute) return { ok: false, reason: "too_many_per_minute" } as const;
    const run = kind === "turn" ? await runTotals(tx as unknown as Sql, row.accountId, row.runId) : { turns: 0, costMicros: 0 };
    if (kind === "turn" && run.turns >= limits.maxTurnsPerRun) return { ok: false, reason: "run_limit_reached", limit: "turns" } as const;
    if (kind === "turn" && run.costMicros >= limits.maxCostPerRunMicros) return { ok: false, reason: "run_limit_reached", limit: "cost" } as const;
    const [inserted] = await tx<{ id: number }[]>`
      insert into usage_ledger (account_id, device_id, project_hash, thread_id, run_id, turn_index, task_type, kind, model,
                                cost_micros, stop_reason, config_version)
      values (${row.accountId}, ${row.deviceId}, ${row.projectHash}, ${row.threadId}, ${row.runId}, ${row.turnIndex},
              ${row.taskType}, ${kind}, ${row.model}, ${reserveMicros}, ${IN_FLIGHT}, ${row.configVersion})
      returning id`;
    return { ok: true, id: inserted!.id, run } as const;
  });
}

/** Marks a turn in flight as still running, so its hold doesn't lapse however long it streams. */
export async function heartbeatTurn(sql: Sql, reservationId: number): Promise<void> {
  await sql`update usage_ledger set latency_ms = (extract(epoch from now() - created_at) * 1000)::int
    where id = ${reservationId} and stop_reason = ${IN_FLIGHT}`;
}

/** Drops a reservation for a turn that never started (the model was unavailable before any byte). */
export async function releaseTurn(sql: Sql, accountId: string, reservationId: number): Promise<void> {
  await sql`delete from usage_ledger where id = ${reservationId} and account_id = ${accountId} and stop_reason = ${IN_FLIGHT}`;
}
