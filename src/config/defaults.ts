import type { ConfigDoc, TaskProfile } from "./schema.js";

const opus = (p: Pick<TaskProfile, "effort" | "maxOutputTokens" | "taskBudgetTokens">): TaskProfile => ({
  model: "claude-opus-5-5",
  thinkingUpdates: true,
  refusalFallback: true,
  mode: "live",
  ...p,
});

/**
 * Starting config from the spec's task profile table. The live config is the
 * newest row in `config_versions`; this is used only until one is published
 * (`npm run config -- publish`).
 */
export const DEFAULT_CONFIG: ConfigDoc = {
  taskProfiles: {
    ask: opus({ effort: "low", maxOutputTokens: 8_000, taskBudgetTokens: 20_000 }),
    explain_more: opus({ effort: "low", maxOutputTokens: 8_000, taskBudgetTokens: 20_000 }),
    change: opus({ effort: "medium", maxOutputTokens: 32_000, taskBudgetTokens: 60_000 }),
    review: opus({ effort: "medium", maxOutputTokens: 32_000, taskBudgetTokens: 60_000 }),
    fix: opus({ effort: "medium", maxOutputTokens: 32_000, taskBudgetTokens: 60_000 }),
    advise: opus({ effort: "high", maxOutputTokens: 64_000, taskBudgetTokens: 120_000 }),
    plan: opus({ effort: "high", maxOutputTokens: 64_000, taskBudgetTokens: 120_000 }),
    retry_high: opus({ effort: "high", maxOutputTokens: 32_000, taskBudgetTokens: 60_000 }),
    overnight_review: { ...opus({ effort: "high", maxOutputTokens: 64_000, taskBudgetTokens: null }), mode: "batch" },
    chore: {
      model: "claude-haiku-5-5",
      effort: "low",
      maxOutputTokens: 1_000,
      taskBudgetTokens: null,
      thinkingUpdates: false,
      refusalFallback: false, // Haiku has no server-side fallback
      mode: "live",
    },
  },
  // USD per million tokens. Cache writes: 1.25x input (5 minute), 2x input (1 hour).
  // Fallback models are listed so a fallback-served turn is priced correctly.
  // Haiku 5.5 prices are its up-to-100K-token tier; check against Anthropic's pricing page.
  prices: {
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
    "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
    "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
  },
  // Allowances are an open question in the spec; these are placeholders.
  plans: {
    beta: { name: "Private beta", monthlyAllowanceMicros: 50_000_000 },
    internal: { name: "Internal", monthlyAllowanceMicros: 1_000_000_000 },
  },
  toolAllowlist: {},
  limits: {
    maxTurnsPerRun: 8,
    maxCostPerRunMicros: 1_000_000,
    maxCacheBreakpoints: 4,
    maxImages: 3,
    maxBodyBytes: 2 * 1024 * 1024,
    allowanceWarningRatio: 0.8,
    turnsPerMinute: 30,
    concurrentRuns: 3,
    signInsPerHourPerIp: 10,
  },
  minAppVersion: "0.0.0",
  features: {},
  enforceToolAllowlist: false,
};
