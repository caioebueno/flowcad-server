import { z } from "zod";
import { EFFORT_LEVELS, TASK_TYPES, effortRank, type ConfigDoc, type TaskProfile, type TaskType } from "../config/schema.js";
import { ApiError, outsideProfile } from "../errors.js";
import { toolHash } from "./toolHash.js";

const CacheControl = z.strictObject({ type: z.literal("ephemeral"), ttl: z.enum(["5m", "1h"]).optional() });

const SystemBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: CacheControl.optional(),
});

const Tool = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: CacheControl.optional(),
  strict: z.boolean().optional(),
  eager_input_streaming: z.boolean().optional(),
});

// Content blocks are passed through as the app built them (text, image,
// tool_use, tool_result, thinking...). Their shape is the Messages API's
// business; the checks here are counts and a type allowlist.
const ContentBlock = z.looseObject({ type: z.string() });

const Message = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ContentBlock).min(1)]),
});

/**
 * The model request the app built. Unknown fields are removed (z.object
 * strips), so the app can't sneak in model, thinking, output_config,
 * fallbacks or similar: those come from the task profile.
 */
export const ModelRequest = z.object({
  system: z.union([z.string(), z.array(SystemBlock)]).optional(),
  tools: z.array(Tool).max(64).optional(),
  messages: z.array(Message).min(1),
});
export type ModelRequest = z.infer<typeof ModelRequest>;

export const TurnBody = z.strictObject({
  taskType: z.enum(TASK_TYPES),
  runId: z.string().min(1).max(100),
  turnIndex: z.number().int().nonnegative(),
  projectId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  /** Lower the depth within the profile. Never above the profile. */
  effort: z.enum(EFFORT_LEVELS).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  request: ModelRequest,
});
export type TurnBody = z.infer<typeof TurnBody>;

const BLOCK_TYPES = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "fallback",
]);

function walk(value: unknown, visit: (obj: Record<string, unknown>) => void) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === "object") {
    visit(value as Record<string, unknown>);
    Object.values(value).forEach((v) => walk(v, visit));
  }
}

/**
 * Server tools (web search, code execution...) arrive with a `type` and no
 * input_schema. Checked on the raw body, before the schema strips `type`, so
 * the app gets a clear 422 rather than a shape error.
 */
export function rejectServerTools(raw: unknown) {
  const tools = (raw as { request?: { tools?: unknown } })?.request?.tools;
  if (!Array.isArray(tools)) return;
  for (const t of tools) {
    const type = (t as { type?: unknown })?.type;
    if (type !== undefined && type !== "custom") throw outsideProfile("Server tools are not allowed", { type: String(type) });
  }
}

/**
 * Checks a turn against its task profile and the limits in config. Throws
 * 422 for anything the profile doesn't allow.
 */
export function checkAgainstProfile(body: TurnBody, config: ConfigDoc): TaskProfile {
  const profile = config.taskProfiles[body.taskType as TaskType];
  if (!profile) throw outsideProfile(`No profile for task type ${body.taskType}`);
  if (profile.mode !== "live") throw outsideProfile(`Task type ${body.taskType} only runs as a batch`);

  if (body.effort && effortRank(body.effort) > effortRank(profile.effort)) {
    throw outsideProfile("Effort above the profile maximum", { max: profile.effort });
  }
  if (body.maxOutputTokens && body.maxOutputTokens > profile.maxOutputTokens) {
    throw outsideProfile("Max output above the profile maximum", { max: profile.maxOutputTokens });
  }

  const allow = config.toolAllowlist[body.taskType];
  if (allow || config.enforceToolAllowlist) {
    for (const tool of body.request.tools ?? []) {
      const expected = allow?.[tool.name];
      if (!expected) throw outsideProfile("Tool not allowed for this task type", { tool: tool.name });
      if (expected !== toolHash(tool)) throw outsideProfile("Tool schema does not match the allowlist", { tool: tool.name });
    }
  }

  let breakpoints = 0;
  let images = 0;
  walk(body.request, (obj) => {
    if ("cache_control" in obj) breakpoints++;
    if (obj.type === "image") images++;
  });
  if (breakpoints > config.limits.maxCacheBreakpoints) {
    throw outsideProfile("Too many cache breakpoints", { max: config.limits.maxCacheBreakpoints });
  }
  if (images > config.limits.maxImages) {
    throw new ApiError(413, "request_too_large", "Too many images", { max: config.limits.maxImages });
  }

  for (const m of body.request.messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (!BLOCK_TYPES.has(block.type)) throw outsideProfile("Content block type not allowed", { type: block.type });
    }
  }
  return profile;
}
