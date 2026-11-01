import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { requireAttestation } from "../auth/middleware.js";
import { checkAgainstProfile, rejectServerTools, TurnBody } from "./request.js";
import { buildParams, mapUpstreamError, type StreamEvent } from "./upstream.js";
import { priceUsage, StreamUsage } from "./usage.js";
import { monthUsedMicros, projectHash, recordUsage, runTotals } from "../ledger/ledger.js";
import { log } from "../logger.js";
import type { LoadedConfig } from "../config/store.js";
import type { Plan } from "../billing/plans.js";

/** Hard ceiling on bytes read; the config limit (2 MB by default) is checked after. */
const HARD_BODY_LIMIT = 8 * 1024 * 1024;

const percent = (used: number, limit: number) => (limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 1000) / 10));

interface Prepared {
  body: TurnBody;
  config: LoadedConfig;
  plan: Plan;
  usedMicros: number;
  profile: ReturnType<typeof checkAgainstProfile>;
}

/** Steps 1 to 3 of the proxy: size, shape, profile, allowance. */
async function prepare(c: Context<AppEnv>, deps: Deps): Promise<Prepared> {
  const config = await deps.config.current();
  const text = await c.req.text();
  if (Buffer.byteLength(text) > config.doc.limits.maxBodyBytes) {
    throw new ApiError(413, "request_too_large", "Request over the size limit", { maxBytes: config.doc.limits.maxBodyBytes });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "Body must be JSON");
  }
  rejectServerTools(raw);
  const parsed = TurnBody.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), code: i.code }));
    throw new ApiError(400, "invalid_request", "Request body is invalid", { issues });
  }
  const body = parsed.data;
  const profile = checkAgainstProfile(body, config.doc);

  const { accountId } = c.get("auth");
  const plan = await deps.plans.planFor(accountId, config.doc);
  // AI needs Pro or a trial. Checked before the allowance so Free accounts
  // see the upgrade sheet, not the allowance sheet.
  if (plan.tier !== "pro") throw new ApiError(403, "plan_required", "The agent is part of Keel Pro");
  const usedMicros = await monthUsedMicros(deps.sql, accountId);
  if (usedMicros >= plan.monthlyAllowanceMicros) {
    throw new ApiError(402, "allowance_exhausted", "This month's AI allowance is used up");
  }
  return { body, config, plan, usedMicros, profile };
}

export function proxyRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const limit = bodyLimit({
    maxSize: HARD_BODY_LIMIT,
    onError: () => {
      throw new ApiError(413, "request_too_large", "Request over the size limit");
    },
  });

  app.post("/turn", limit, requireAttestation(deps), async (c) => {
    const started = Date.now();
    const { body, config, plan, usedMicros, profile } = await prepare(c, deps);
    const { accountId, deviceId } = c.get("auth");
    const limits = config.doc.limits;

    const run = await runTotals(deps.sql, accountId, body.runId);
    const runLimit =
      run.turns >= limits.maxTurnsPerRun ? "turns" : run.costMicros >= limits.maxCostPerRunMicros ? "cost" : null;
    if (runLimit) {
      return streamSSE(c, async (s) => {
        await s.writeSSE({
          event: "keel.error",
          data: JSON.stringify({
            type: "keel.error",
            code: "run_limit_reached",
            message: "This run has reached its limit. Continue as a new run.",
            limit: runLimit,
          }),
        });
      });
    }

    const params = buildParams(profile, body.request, { effort: body.effort, maxOutputTokens: body.maxOutputTokens });
    const abort = new AbortController();
    // Throws ApiError (502/503/413) before any byte is sent to the app.
    const events = await deps.upstream.stream(params, abort.signal);

    return streamSSE(c, async (s) => {
      s.onAbort(() => abort.abort());
      const usage = new StreamUsage();
      let stopReason: string | null = null;
      let failed = false;

      try {
        for await (const event of events as AsyncIterable<StreamEvent>) {
          usage.observe(event as never);
          await s.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (s.aborted) break;
        }
        stopReason = usage.stopReason;
      } catch (err) {
        if (s.aborted || abort.signal.aborted) {
          stopReason = "client_disconnected";
        } else {
          failed = true;
          stopReason = "upstream_error";
          const mapped = mapUpstreamError(err);
          log.warn("stream_failed", { account: accountId, run: body.runId, code: mapped.code });
          await s.writeSSE({
            event: "keel.error",
            data: JSON.stringify({ type: "keel.error", code: mapped.code, status: mapped.status, message: mapped.message }),
          });
        }
      }
      if (s.aborted && !stopReason) stopReason = "client_disconnected";

      // Whatever happened, Anthropic billed what it produced, so it is recorded.
      const priced = priceUsage(config.doc, profile.model, usage.raw);
      const latencyMs = Date.now() - started;
      const { usedMicros: newUsed } = await recordUsage(
        deps.sql,
        {
          accountId,
          deviceId,
          projectHash: projectHash(deps.projectHashSalt, accountId, body.projectId),
          threadId: body.threadId,
          runId: body.runId,
          turnIndex: body.turnIndex,
          taskType: body.taskType,
          kind: "turn",
          model: profile.model,
          servedModel: priced.servedModel,
          inputTokens: priced.inputTokens,
          cacheWriteTokens: priced.cacheWrite5mTokens + priced.cacheWrite1hTokens,
          cacheReadTokens: priced.cacheReadTokens,
          outputTokens: priced.outputTokens,
          costMicros: priced.costMicros,
          stopReason,
          latencyMs,
          configVersion: config.version,
        },
        plan.monthlyAllowanceMicros,
      ).catch((err) => {
        // Losing a ledger row is bad but must not hide the reply already sent.
        log.error("ledger_write_failed", { account: accountId, run: body.runId, err: (err as Error).message });
        return { usedMicros: usedMicros + priced.costMicros };
      });
      log.info("turn", {
        account: accountId,
        run: body.runId,
        turn: body.turnIndex,
        task: body.taskType,
        in: priced.inputTokens,
        out: priced.outputTokens,
        cost: priced.costMicros,
        stop: stopReason,
        ms: latencyMs,
      });

      if (s.aborted) return;
      const allowanceUsedPercent = percent(newUsed, plan.monthlyAllowanceMicros);
      await s.writeSSE({
        event: "keel.usage",
        data: JSON.stringify({
          type: "keel.usage",
          inputTokens: priced.inputTokens,
          cacheWriteTokens: priced.cacheWrite5mTokens + priced.cacheWrite1hTokens,
          cacheReadTokens: priced.cacheReadTokens,
          outputTokens: priced.outputTokens,
          costMicros: priced.costMicros,
          servedModel: priced.servedModel,
          allowanceUsedPercent,
          allowanceLeftPercent: Math.max(0, Math.round((100 - allowanceUsedPercent) * 10) / 10),
          runTurnsLeft: Math.max(0, limits.maxTurnsPerRun - run.turns - 1),
          runBudgetUsedPercent: percent(run.costMicros + priced.costMicros, limits.maxCostPerRunMicros),
        }),
      });
      if (!failed && newUsed >= plan.monthlyAllowanceMicros * limits.allowanceWarningRatio) {
        await s.writeSSE({
          event: "keel.warning",
          data: JSON.stringify({ type: "keel.warning", code: "allowance_low", allowanceUsedPercent }),
        });
      }
    });
  });

  app.post("/keepwarm", limit, requireAttestation(deps), async (c) => {
    const started = Date.now();
    const { body, config, plan, profile } = await prepare(c, deps);
    const { accountId, deviceId } = c.get("auth");
    const params = buildParams(profile, body.request, { effort: body.effort, maxOutputTokens: body.maxOutputTokens });
    const usage = await deps.upstream.prewarm(params);
    const priced = priceUsage(config.doc, profile.model, usage as never);
    const { usedMicros } = await recordUsage(
      deps.sql,
      {
        accountId,
        deviceId,
        projectHash: projectHash(deps.projectHashSalt, accountId, body.projectId),
        threadId: body.threadId,
        runId: body.runId,
        turnIndex: body.turnIndex,
        taskType: body.taskType,
        kind: "keepwarm",
        model: profile.model,
        servedModel: null,
        inputTokens: priced.inputTokens,
        cacheWriteTokens: priced.cacheWrite5mTokens + priced.cacheWrite1hTokens,
        cacheReadTokens: priced.cacheReadTokens,
        outputTokens: priced.outputTokens,
        costMicros: priced.costMicros,
        stopReason: "max_tokens",
        latencyMs: Date.now() - started,
        configVersion: config.version,
      },
      plan.monthlyAllowanceMicros,
    );
    return c.json({
      inputTokens: priced.inputTokens,
      cacheWriteTokens: priced.cacheWrite5mTokens + priced.cacheWrite1hTokens,
      cacheReadTokens: priced.cacheReadTokens,
      outputTokens: priced.outputTokens,
      costMicros: priced.costMicros,
      allowanceUsedPercent: percent(usedMicros, plan.monthlyAllowanceMicros),
    });
  });

  return app;
}
