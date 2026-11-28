import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { log } from "../logger.js";
import { buildQuery, toStepModels, type StepModelResult } from "./stepModels.js";

const Body = z.strictObject({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(10).default(5),
});

/** Searches per account in the last hour, on this instance. Two replicas make it approximate, which is enough to stop a loop. */
const recent = new Map<string, number[]>();
/** Answers for an hour, so the same part searched again costs nothing. */
const cache = new Map<string, { at: number; results: StepModelResult[] }>();
const HOUR = 3_600_000;
const CACHE_SIZE = 500;

export function resetSearchState() {
  recent.clear();
  cache.clear();
}

/**
 * POST /search/step-models: the agent's search_step_models, answered here so
 * the same tool works whichever model serves the turn. Only the sites in
 * config are searched, and only what the provider finds there comes back.
 * No query is stored; the log holds its length and the result count.
 */
export function searchRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.post("/step-models", async (c) => {
    const config = (await deps.config.current()).doc;
    const settings = config.stepSearch ?? DEFAULT_CONFIG.stepSearch!;
    if (!settings.enabled || !deps.search) throw new ApiError(503, "search_unavailable", "Online search is off");

    const { accountId } = c.get("auth");
    const plan = await deps.plans.planFor(accountId, config);
    if (plan.tier !== "pro") throw new ApiError(403, "plan_required", "The agent is part of Keel Pro");

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "invalid_request", "Body must be JSON");
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), code: i.code }));
      throw new ApiError(400, "invalid_request", "Request body is invalid", { issues });
    }
    const { query, limit } = parsed.data;

    const now = Date.now();
    const times = (recent.get(accountId) ?? []).filter((t) => now - t < HOUR);
    if (times.length >= settings.searchesPerHour) {
      throw new ApiError(429, "rate_limited", "Too many searches this hour", { retryAfter: Math.ceil((times[0]! + HOUR - now) / 1000) });
    }

    const key = `${query.toLowerCase()}|${limit}|${settings.sites.map((s) => s.host).join(",")}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < HOUR) return c.json({ results: hit.results });

    times.push(now);
    recent.set(accountId, times);
    let results: StepModelResult[];
    try {
      // More than asked for: some land on sites outside the list and are dropped.
      const found = await deps.search.search(buildQuery(query, settings.sites), Math.min(limit * 3, 20));
      results = toStepModels(found, settings.sites, limit);
    } catch (err) {
      // The message names the engines that were down, never the query.
      log.warn("search_failed", { account: accountId, err: (err as Error).message });
      throw new ApiError(502, "upstream_error", "The search provider didn't answer");
    }
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now, results });
    log.info("step_search", { account: accountId, queryLength: query.length, results: results.length });
    return c.json({ results });
  });

  return app;
}
