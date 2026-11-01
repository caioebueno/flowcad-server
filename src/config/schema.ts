import { z } from "zod";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const effortRank = (e: Effort) => EFFORT_LEVELS.indexOf(e);

export const TASK_TYPES = [
  "ask",
  "explain_more",
  "change",
  "review",
  "fix",
  "advise",
  "plan",
  "retry_high",
  "overnight_review",
  "chore",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TaskProfileSchema = z.strictObject({
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS),
  maxOutputTokens: z.number().int().positive(),
  /** Task budget in tokens (beta). null means no task budget is sent. */
  taskBudgetTokens: z.number().int().min(20_000).nullable(),
  /** Adaptive thinking with progress notes ("updates" display). */
  thinkingUpdates: z.boolean(),
  /** Server-side fallback for refused requests. */
  refusalFallback: z.boolean(),
  /** "live" turns go through /agent/turn; "batch" only through /batches (phase 3). */
  mode: z.enum(["live", "batch"]),
});
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

/** Prices in US dollars per million tokens, which is the same number as micro dollars per token. */
export const ModelPriceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheWrite5m: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PlanSchema = z.strictObject({
  name: z.string(),
  /** "pro" plans can use the AI; "free" plans get 403 plan_required. */
  tier: z.enum(["free", "pro"]),
  /** AI credits each credit period (the Stripe billing period, or the calendar month for hand-assigned plans). */
  monthlyCredits: z.number().int().nonnegative(),
});

export const ConfigDocSchema = z.strictObject({
  taskProfiles: z.record(z.enum(TASK_TYPES), TaskProfileSchema),
  prices: z.record(z.string(), ModelPriceSchema),
  plans: z.record(z.string(), PlanSchema),
  /**
   * Allowed tools per task type: tool name -> sha256 of the canonical tool
   * schema (see src/proxy/toolHash.ts). A task type with no entry here accepts
   * any custom tool until `enforceToolAllowlist` is turned on.
   */
  toolAllowlist: z.record(z.string(), z.record(z.string(), z.string())),
  limits: z.strictObject({
    maxTurnsPerRun: z.number().int().positive(),
    maxCostPerRunMicros: z.number().int().positive(),
    maxCacheBreakpoints: z.number().int().nonnegative(),
    maxImages: z.number().int().nonnegative(),
    maxBodyBytes: z.number().int().positive(),
    allowanceWarningRatio: z.number().min(0).max(1),
    // Phase 2 values, served now so the app can read them.
    turnsPerMinute: z.number().int().positive(),
    concurrentRuns: z.number().int().positive(),
    signInsPerHourPerIp: z.number().int().positive(),
  }),
  credits: z.strictObject({
    /** Credits per US dollar of model cost. 150 means one credit is 1/150 of a dollar. */
    perDollar: z.number().positive(),
  }),
  billing: z.strictObject({
    /** Free Pro trial length, given once per account through Stripe Checkout. */
    trialDays: z.number().int().min(0).max(90),
    /** Credits for the whole trial, in place of the plan's monthly credits. */
    trialCredits: z.number().int().nonnegative(),
    /** One-time credit packs, bought through Stripe Checkout. */
    pack: z.strictObject({
      credits: z.number().int().positive(),
      validMonths: z.number().int().positive(),
    }),
  }),
  minAppVersion: z.string(),
  features: z.record(z.string(), z.boolean()),
  enforceToolAllowlist: z.boolean(),
});
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;
