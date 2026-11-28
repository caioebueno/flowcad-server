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
  // Routing (Nov 28): a typed message whose job the model's first move decides, and one part of a parts card.
  "auto",
  "build",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Task types added after configs were first published. A stored config
 * without a profile for one of them uses its base type's, so publishing a
 * new server never needs a config change first.
 */
export const BASE_TASK_TYPE: Partial<Record<TaskType, TaskType>> = { auto: "change", build: "change" };

/** The type whose settings stand in for a task type the config doesn't list. */
export const baseTaskType = (t: TaskType): TaskType => BASE_TASK_TYPE[t] ?? t;

/** The rungs of the model ladder: cheap is the self-hosted model, mid and top are Claude models. */
export const TIERS = ["cheap", "mid", "top"] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: Tier) => TIERS.indexOf(t);

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

/** Model names served by the self-hosted upstream (vLLM, e.g. on Vast.ai) start with this. */
export const SELF_HOSTED_PREFIX = "self:";

/**
 * The self-hosted model as the primary model. Listed task types go to it
 * first; a turn it can't start (box off, error before the stream) goes to the
 * task type's Claude profile instead. Needs SELF_HOSTED_BASE_URL as well.
 */
export const SelfHostedSchema = z.strictObject({
  enabled: z.boolean(),
  /** Plans routed to it. Absent means every plan that can use the agent. */
  plans: z.array(z.string()).optional(),
  taskProfiles: z.partialRecord(
    z.enum(TASK_TYPES),
    TaskProfileSchema.refine((p) => p.model.startsWith(SELF_HOSTED_PREFIX), {
      message: `Self-hosted model names start with "${SELF_HOSTED_PREFIX}"`,
    }),
  ),
});
export type SelfHosted = z.infer<typeof SelfHostedSchema>;

/**
 * The agent's search_step_models (POST /search/step-models): ready-made STEP
 * models of standard and bought-in parts, from these sites only. `direct`
 * sites serve the file to anyone, so the app can download it itself.
 */
export const StepSearchSchema = z.strictObject({
  enabled: z.boolean(),
  sites: z
    .array(
      z.strictObject({
        /** Matches the host and its subdomains, as "github.com". */
        host: z.string().regex(/^[a-z0-9.-]+\.[a-z]+$/),
        name: z.string().min(1),
        direct: z.boolean(),
        /** Said with every result from the site, when the site has one licence. */
        license: z.string().optional(),
      }),
    )
    .min(1),
  searchesPerHour: z.number().int().positive(),
});
export type StepSearch = z.infer<typeof StepSearchSchema>;

/** Copies a base type's profile into each newer task type a stored config doesn't list. */
function fillNewTaskTypes(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const profiles = { ...(value as Record<string, unknown>) };
  for (const [type, base] of Object.entries(BASE_TASK_TYPE)) {
    if (profiles[type] === undefined && profiles[base] !== undefined) profiles[type] = profiles[base];
  }
  return profiles;
}

/**
 * Tiered routing (Keel AI Routing guide, Nov 28). The app sends a tier with
 * each turn; `tiers` off means the server ignores it and routes as before.
 * `ladder` and `cacheOrder` are read by the app.
 */
export const RoutingSchema = z.strictObject({
  tiers: z.boolean(),
  ladder: z.boolean(),
  cacheOrder: z.boolean(),
  /** Claude model and effort for the mid and top tiers; output cap, budget and thinking stay the task type's. */
  mid: z.strictObject({ model: z.string(), effort: z.enum(EFFORT_LEVELS) }),
  top: z.strictObject({ model: z.string(), effort: z.enum(EFFORT_LEVELS) }),
  /** The lowest tier a task type runs at, whatever the app sends. Raised here when the cheap tier fails it too often. */
  floors: z.partialRecord(z.enum(TASK_TYPES), z.enum(TIERS)).default({}),
  /** Seconds the self-hosted model is skipped after it fails to start a turn, so turns don't each wait for it. */
  selfHostedCooldownSeconds: z.number().int().nonnegative().default(60),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const ConfigDocSchema = z.strictObject({
  taskProfiles: z.preprocess(fillNewTaskTypes, z.record(z.enum(TASK_TYPES), TaskProfileSchema)),
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
    /**
     * Credits a Free account gets once, so a new maker can design something before paying (Keel Make
     * spec §9.1). 0 turns Free AI off again. Optional so stored config docs from before keep parsing.
     */
    starterCredits: z.number().int().nonnegative().default(300),
    /** One-time credit packs, bought through Stripe Checkout. */
    pack: z.strictObject({
      credits: z.number().int().positive(),
      validMonths: z.number().int().positive(),
    }),
  }),
  minAppVersion: z.string(),
  features: z.record(z.string(), z.boolean()),
  enforceToolAllowlist: z.boolean(),
  /** Off when absent. */
  selfHosted: SelfHostedSchema.optional(),
  /** The bundled default when absent, so a config published before it still searches. */
  stepSearch: StepSearchSchema.optional(),
  /** Off when absent: the tier the app sends is ignored. */
  routing: RoutingSchema.optional(),
});
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;
