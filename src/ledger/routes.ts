import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { monthOf, monthUsedMicros, projectHash } from "./ledger.js";
import { revokeDevice } from "../auth/tokens.js";

const percent = (used: number, limit: number) => (limit <= 0 ? 100 : Math.round((used / limit) * 1000) / 10);

const nextMonth = (month: string) => {
  const d = new Date(`${month}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

/**
 * Account summary and usage. Money never leaves the server as dollars: the
 * app shows the allowance as a percent, so price changes stay invisible.
 */
export function accountRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.get("/account", async (c) => {
    const { accountId, deviceId } = c.get("auth");
    const { doc } = await deps.config.current();
    const plan = await deps.plans.planFor(accountId, doc);
    const used = await monthUsedMicros(deps.sql, accountId);
    const month = monthOf();
    const [account] = await deps.sql<{ email_relay: string | null; created_at: Date; status: string }[]>`
      select email_relay, created_at, status from accounts where id = ${accountId}`;
    const usedPercent = percent(used, plan.monthlyAllowanceMicros);
    return c.json({
      id: accountId,
      email: account?.email_relay ?? null,
      status: account?.status,
      createdAt: account?.created_at.toISOString(),
      plan: { id: plan.id, name: plan.name },
      allowance: {
        periodStart: new Date(`${month}T00:00:00Z`).toISOString(),
        periodEnd: nextMonth(month),
        usedPercent: Math.min(100, usedPercent),
        warning: usedPercent >= doc.limits.allowanceWarningRatio * 100,
        exhausted: used >= plan.monthlyAllowanceMicros,
      },
      currentDeviceId: deviceId,
    });
  });

  app.get("/account/devices", async (c) => {
    const { accountId, deviceId } = c.get("auth");
    const rows = await deps.sql<
      { id: string; name: string | null; app_version: string | null; created_at: Date; last_seen_at: Date }[]
    >`select id, name, app_version, created_at, last_seen_at from devices
      where account_id = ${accountId} and revoked_at is null order by last_seen_at desc`;
    return c.json({
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        appVersion: d.app_version,
        createdAt: d.created_at.toISOString(),
        lastSeenAt: d.last_seen_at.toISOString(),
        current: d.id === deviceId,
      })),
    });
  });

  app.delete("/account/devices/:id", async (c) => {
    const { accountId } = c.get("auth");
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) throw new ApiError(404, "not_found", "No such device");
    const [row] = await deps.sql`select id from devices where id = ${id} and account_id = ${accountId}`;
    if (!row) throw new ApiError(404, "not_found", "No such device");
    await revokeDevice(deps.sql, id);
    return c.body(null, 204);
  });

  const UsageQuery = z.strictObject({
    groupBy: z.enum(["day", "task_type", "project"]).default("day"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    /** Comma-separated project ids the app knows, so project rows can be labelled. */
    projectIds: z.string().max(10_000).optional(),
  });

  app.get("/usage", async (c) => {
    const parsed = UsageQuery.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError(400, "invalid_request", "Invalid query");
    const q = parsed.data;
    const { accountId } = c.get("auth");
    const { doc } = await deps.config.current();
    const plan = await deps.plans.planFor(accountId, doc);

    const from = q.from ?? monthOf();
    const toExclusive = q.to
      ? new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000).toISOString()
      : nextMonth(monthOf());

    const key =
      q.groupBy === "day"
        ? deps.sql`to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD')`
        : q.groupBy === "task_type"
          ? deps.sql`task_type`
          : deps.sql`project_hash`;

    const rows = await deps.sql<
      { key: string; turns: number; input: number; cache_write: number; cache_read: number; output: number; cost: number }[]
    >`
      select ${key} as key,
             count(*)::bigint as turns,
             sum(input_tokens)::bigint as input,
             sum(cache_write_tokens)::bigint as cache_write,
             sum(cache_read_tokens)::bigint as cache_read,
             sum(output_tokens)::bigint as output,
             sum(cost_micros)::bigint as cost
      from usage_ledger
      where account_id = ${accountId} and created_at >= ${from}::timestamptz and created_at < ${toExclusive}::timestamptz
      group by 1 order by 1`;

    const labels = new Map<string, string>();
    if (q.groupBy === "project" && q.projectIds) {
      for (const id of q.projectIds.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500)) {
        labels.set(projectHash(deps.projectHashSalt, accountId, id), id);
      }
    }

    return c.json({
      groupBy: q.groupBy,
      from,
      to: toExclusive,
      rows: rows.map((r) => ({
        key: r.key,
        ...(q.groupBy === "project" ? { projectId: labels.get(r.key) ?? null } : {}),
        turns: r.turns,
        inputTokens: r.input,
        cacheWriteTokens: r.cache_write,
        cacheReadTokens: r.cache_read,
        outputTokens: r.output,
        allowancePercent: percent(r.cost, plan.monthlyAllowanceMicros),
      })),
    });
  });

  return app;
}
