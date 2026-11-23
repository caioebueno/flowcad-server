import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { requireAttestation } from "../auth/middleware.js";
import { checkAgainstProfile, rejectServerTools, TurnBody } from "./request.js";
import { buildParams, mapUpstreamError, type StreamEvent, type UpstreamParams } from "./upstream.js";
import { dropSelfHostedThinking, selfHostedProfile } from "./selfHosted.js";
import type { TaskProfile } from "../config/schema.js";
import { priceUsage, StreamUsage, worstCaseMicros } from "./usage.js";
import { heartbeatTurn, projectHash, recordUsage, releaseTurn, RESERVATION_HEARTBEAT_SECONDS, reserveTurn, type Reservation } from "../ledger/ledger.js";
import { creditBalance, creditPeriod, creditsLeft, isExhausted, isLow, microsPerCredit, type CreditPeriod } from "../billing/credits.js";
import { packsAvailable } from "../billing/entitlement.js";
import { log } from "../logger.js";
import type { LoadedConfig } from "../config/store.js";
import type { Plan } from "../billing/plans.js";

/** Hard ceiling on bytes read; the config limit (2 MB by default) is checked after. */
const HARD_BODY_LIMIT = 8 * 1024 * 1024;

const percent = (used: number, limit: number) => (limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 1000) / 10));

/** Whole credits for a cost, rounded up: any use costs at least one credit. */
const creditsCharged = (costMicros: number, mpc: number) => (costMicros <= 0 ? 0 : Math.ceil(costMicros / mpc - 1e-9));

interface Prepared {
  body: TurnBody;
  bodyBytes: number;
  config: LoadedConfig;
  plan: Plan;
  period: CreditPeriod;
  usedMicros: number;
  extraMicros: number;
  profile: ReturnType<typeof checkAgainstProfile>;
  /** Tried before `profile` when the self-hosted model is configured and on. */
  selfProfile: TaskProfile | null;
}

/** Steps 1 to 3 of the proxy: size, shape, profile, plan and credits. */
async function prepare(c: Context<AppEnv>, deps: Deps): Promise<Prepared> {
  const config = await deps.config.current();
  const text = await c.req.text();
  const bodyBytes = Buffer.byteLength(text);
  if (bodyBytes > config.doc.limits.maxBodyBytes) {
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
  // AI needs Pro, a trial, or a Free account's starter credits (Keel Make spec §9.1). With starter credits
  // turned off, Free accounts see the upgrade sheet, not the allowance sheet.
  const period = await creditPeriod(deps.sql, accountId, plan, config.doc);
  if (!period) throw new ApiError(403, "plan_required", "The agent is part of Keel Pro");
  const balance = await creditBalance(deps.sql, accountId, period);
  if (isExhausted(period, balance)) throw creditsExhausted(deps, period);
  const selfProfile = deps.selfHosted ? selfHostedProfile(config.doc, plan, body.taskType) : null;
  return { body, bodyBytes, config, plan, period, usedMicros: balance.monthlyUsedMicros, extraMicros: balance.extraMicros, profile, selfProfile };
}

const creditsExhausted = (deps: Deps, period: CreditPeriod) =>
  new ApiError(402, "credits_exhausted", "You're out of AI credits", {
    isTrial: period.isTrial,
    ...(period.isStarter ? { isStarter: true } : {}),
    resetsAt: period.end.toISOString(),
    // Packs are part of Pro: a Free account that used its starter credits is offered Pro instead.
    canBuyPack: !period.isTrial && !period.isStarter && packsAvailable(deps),
    ...(period.paymentFailed ? { paymentFailed: true } : {}),
  });

/** The answer to a turn or keepwarm `reserveTurn` refused, other than a run cap. */
function refused(deps: Deps, period: CreditPeriod, r: Exclude<Reservation, { ok: true } | { reason: "run_limit_reached" }>, log_: { account: string; run: string }) {
  if (r.reason === "credits_exhausted") return creditsExhausted(deps, period);
  log.warn("turn_rate_limited", { ...log_, reason: r.reason });
  const message =
    r.reason === "credits_held"
      ? "Your other agent turns are using the rest of your credits. Try again when they finish."
      : r.reason === "too_many_in_flight"
        ? "Too many agent turns at once. Try again in a moment."
        : "Too many agent turns. Try again in a moment.";
  return new ApiError(429, "rate_limited", message, { reason: r.reason, retryAfter: r.reason === "too_many_per_minute" ? 60 : 5 });
}

/** About 3 bytes of request JSON a token, which overestimates for text and far overestimates for images. */
const BYTES_PER_TOKEN_ESTIMATE = 3;

/** What a turn could cost at most, on whichever model may serve it. */
function reservationFor(prepared: Prepared): number {
  const { body, bodyBytes, config, profile, selfProfile } = prepared;
  const inputTokens = Math.ceil(bodyBytes / BYTES_PER_TOKEN_ESTIMATE);
  return Math.max(
    ...[profile, selfProfile].filter((p): p is TaskProfile => !!p).map((p) => {
      const maxOut = body.maxOutputTokens ? Math.min(body.maxOutputTokens, p.maxOutputTokens) : p.maxOutputTokens;
      return worstCaseMicros(config.doc, p.model, inputTokens, maxOut);
    }),
  );
}

/** Request options for a profile; the app's own cap never goes above the profile's. */
function paramsFor(profile: TaskProfile, body: TurnBody): UpstreamParams {
  const maxOutputTokens = body.maxOutputTokens ? Math.min(body.maxOutputTokens, profile.maxOutputTokens) : undefined;
  return buildParams(profile, body.request, { effort: body.effort, maxOutputTokens });
}

/**
 * Starts the turn on the self-hosted model when it applies, and on Claude
 * otherwise or when the self-hosted model can't start it. Returns the profile
 * that actually serves the turn, so it is priced and recorded under it.
 */
async function startTurn(
  deps: Deps,
  prepared: Pick<Prepared, "body" | "profile" | "selfProfile">,
  signal: AbortSignal,
  accountId: string,
): Promise<{ events: AsyncIterable<StreamEvent>; served: TaskProfile }> {
  const { body, profile, selfProfile } = prepared;
  if (selfProfile && deps.selfHosted) {
    try {
      return { events: await deps.selfHosted.stream(paramsFor(selfProfile, body), signal), served: selfProfile };
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      log.warn("self_hosted_unavailable", { account: accountId, run: body.runId, code });
    }
  }
  const claudeBody = { ...body, request: dropSelfHostedThinking(body.request) };
  // Throws ApiError (502/503/413) before any byte is sent to the app.
  return { events: await deps.upstream.stream(paramsFor(profile, claudeBody), signal), served: profile };
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
    const prepared = await prepare(c, deps);
    const { body, config, period, usedMicros, extraMicros } = prepared;
    const { accountId, deviceId } = c.get("auth");
    const limits = config.doc.limits;

    const hashedProject = projectHash(deps.projectHashSalt, accountId, body.projectId);

    // Admit the turn and hold back what it could cost, so turns sent at the
    // same time can't spend credits the account doesn't have (see reserveTurn).
    const reservation = await reserveTurn(
      deps.sql,
      {
        accountId,
        deviceId,
        projectHash: hashedProject,
        threadId: body.threadId,
        runId: body.runId,
        turnIndex: body.turnIndex,
        taskType: body.taskType,
        model: prepared.profile.model,
        configVersion: config.version,
      },
      reservationFor(prepared),
      period,
      limits,
    );
    if (!reservation.ok && reservation.reason !== "run_limit_reached") {
      throw refused(deps, period, reservation, { account: accountId, run: body.runId });
    }
    if (!reservation.ok) {
      const runLimit = reservation.limit;
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

    const { run, id: reservationId } = reservation;

    const abort = new AbortController();
    let startedTurn: Awaited<ReturnType<typeof startTurn>>;
    try {
      startedTurn = await startTurn(deps, prepared, abort.signal, accountId);
    } catch (err) {
      // Nothing was generated, so nothing is held or charged.
      await releaseTurn(deps.sql, accountId, reservationId).catch(() => {});
      throw err;
    }
    const { events, served: profile } = startedTurn;
    const upstreamStartedMs = Date.now() - started;

    return streamSSE(c, async (s) => {
      s.onAbort(() => abort.abort());
      // Keeps the hold alive however long the turn streams (see RESERVATION_TTL_MINUTES).
      const heartbeat = setInterval(() => {
        heartbeatTurn(deps.sql, reservationId).catch((err) =>
          log.warn("turn_heartbeat_failed", { account: accountId, run: body.runId, err: (err as Error).message }),
        );
      }, RESERVATION_HEARTBEAT_SECONDS * 1000);
      heartbeat.unref();
      try {
        const maxOut = body.maxOutputTokens ? Math.min(body.maxOutputTokens, profile.maxOutputTokens) : profile.maxOutputTokens;
        const usage = new StreamUsage(maxOut);
        let stopReason: string | null = null;
        let failed = false;
        let firstTokenMs: number | null = null;

        try {
          for await (const event of events as AsyncIterable<StreamEvent>) {
            if (firstTokenMs === null && event.type === "content_block_delta") firstTokenMs = Date.now() - started;
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
        const after = await recordUsage(
          deps.sql,
          {
            accountId,
            deviceId,
            projectHash: hashedProject,
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
          period,
          reservationId,
        ).catch((err) => {
          // Losing a ledger row is bad but must not hide the reply already sent.
          log.error("ledger_write_failed", { account: accountId, run: body.runId, err: (err as Error).message });
          return { monthlyUsedMicros: usedMicros + priced.costMicros, extraMicros };
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
          // Where the time went: which model served it, how long until it
          // started (a self-hosted wait shows here) and how fast it wrote.
          model: profile.model,
          startMs: upstreamStartedMs,
          firstTokenMs,
          tokensPerSec: firstTokenMs !== null && latencyMs > firstTokenMs ? Math.round((priced.outputTokens * 1000) / (latencyMs - firstTokenMs)) : null,
        });

        if (s.aborted) return;
        const allowanceUsedPercent = percent(after.monthlyUsedMicros, period.limitMicros);
        const left = creditsLeft(config.doc, period, after);
        const resetsAt = period.end.toISOString();
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
            model: profile.model,
            creditsCharged: creditsCharged(priced.costMicros, microsPerCredit(config.doc)),
            creditsLeft: left,
            resetsAt,
            // Older builds read these percents of the monthly credits.
            allowanceUsedPercent,
            allowanceLeftPercent: Math.max(0, Math.round((100 - allowanceUsedPercent) * 10) / 10),
            runTurnsLeft: Math.max(0, limits.maxTurnsPerRun - run.turns - 1),
            runBudgetUsedPercent: percent(run.costMicros + priced.costMicros, limits.maxCostPerRunMicros),
          }),
        });
        if (!failed && isLow(config.doc, period, after.monthlyUsedMicros)) {
          await s.writeSSE({
            event: "keel.warning",
            data: JSON.stringify({ type: "keel.warning", code: "credits_low", creditsLeft: left, resetsAt, allowanceUsedPercent }),
          });
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });

  app.post("/keepwarm", limit, requireAttestation(deps), async (c) => {
    const started = Date.now();
    const prepared = await prepare(c, deps);
    const { body, config, period, profile, selfProfile, usedMicros, extraMicros } = prepared;
    const { accountId, deviceId } = c.get("auth");
    if (selfProfile) {
      // The next turn goes to the self-hosted model, whose cache warms itself:
      // nothing to write to Claude's cache, nothing to charge.
      return c.json({
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costMicros: 0,
        creditsCharged: 0,
        creditsLeft: creditsLeft(config.doc, period, { monthlyUsedMicros: usedMicros, extraMicros }),
        allowanceUsedPercent: percent(usedMicros, period.limitMicros),
      });
    }
    const hashedProject = projectHash(deps.projectHashSalt, accountId, body.projectId);
    // A prewarm writes the whole request to the cache, so it is admitted and held like a turn (input only).
    const reservation = await reserveTurn(
      deps.sql,
      {
        accountId,
        deviceId,
        projectHash: hashedProject,
        threadId: body.threadId,
        runId: body.runId,
        turnIndex: body.turnIndex,
        taskType: body.taskType,
        model: profile.model,
        configVersion: config.version,
      },
      worstCaseMicros(config.doc, profile.model, Math.ceil(prepared.bodyBytes / BYTES_PER_TOKEN_ESTIMATE), 0),
      period,
      config.doc.limits,
      "keepwarm",
    );
    if (!reservation.ok) {
      if (reservation.reason === "run_limit_reached") throw new Error("unreachable: keepwarm has no run cap");
      throw refused(deps, period, reservation, { account: accountId, run: body.runId });
    }
    const params = buildParams(profile, body.request, { effort: body.effort, maxOutputTokens: body.maxOutputTokens });
    let usage;
    try {
      usage = await deps.upstream.prewarm(params);
    } catch (err) {
      await releaseTurn(deps.sql, accountId, reservation.id).catch(() => {});
      throw err;
    }
    const priced = priceUsage(config.doc, profile.model, usage as never);
    const after = await recordUsage(
      deps.sql,
      {
        accountId,
        deviceId,
        projectHash: hashedProject,
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
      period,
      reservation.id,
    );
    return c.json({
      inputTokens: priced.inputTokens,
      cacheWriteTokens: priced.cacheWrite5mTokens + priced.cacheWrite1hTokens,
      cacheReadTokens: priced.cacheReadTokens,
      outputTokens: priced.outputTokens,
      costMicros: priced.costMicros,
      creditsCharged: creditsCharged(priced.costMicros, microsPerCredit(config.doc)),
      creditsLeft: creditsLeft(config.doc, period, after),
      allowanceUsedPercent: percent(after.monthlyUsedMicros, period.limitMicros),
    });
  });

  return app;
}
