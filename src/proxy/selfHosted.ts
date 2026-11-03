import Anthropic from "@anthropic-ai/sdk";
import type { BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { SELF_HOSTED_PREFIX, type ConfigDoc, type TaskProfile, type TaskType } from "../config/schema.js";
import type { Plan } from "../billing/plans.js";
import type { ModelRequest } from "./request.js";
import { mapUpstreamError, type StreamEvent, type Upstream, type UpstreamParams } from "./upstream.js";

/** Fields only Claude understands. */
const CLAUDE_ONLY = ["betas", "output_config", "thinking", "fallbacks"] as const;

/** Removes `cache_control` everywhere: vLLM caches prefixes on its own. */
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== "cache_control") out[k] = stripCacheControl(v);
    return out;
  }
  return value;
}

/** Turns Claude-shaped params into what vLLM's /v1/messages accepts. */
export function toSelfHostedParams(params: UpstreamParams): Record<string, unknown> {
  const out = { ...(params as unknown as Record<string, unknown>) };
  for (const k of CLAUDE_ONLY) delete out[k];
  out.model = String(out.model).slice(SELF_HOSTED_PREFIX.length);
  for (const k of ["system", "tools", "messages"]) if (out[k] !== undefined) out[k] = stripCacheControl(out[k]);
  // Claude's encrypted thinking means nothing to another model.
  out.messages = (out.messages as { role: string; content: unknown }[]).map((m) =>
    Array.isArray(m.content)
      ? { ...m, content: m.content.filter((b: { type?: string }) => b.type !== "redacted_thinking") }
      : m,
  );
  return out;
}

/** The self-hosted profile for this turn, or null when it goes straight to Claude. */
export function selfHostedProfile(config: ConfigDoc, plan: Plan, taskType: string): TaskProfile | null {
  const sh = config.selfHosted;
  if (!sh?.enabled) return null;
  if (sh.plans && !sh.plans.includes(plan.id)) return null;
  const profile = sh.taskProfiles[taskType as TaskType];
  return profile?.mode === "live" ? profile : null;
}

/**
 * vLLM signs thinking blocks with a 32-character hex id; Claude's signatures
 * are long base64. Claude rejects a run whose history carries vLLM's, so they
 * are dropped before a turn goes to Claude.
 */
const SELF_HOSTED_SIGNATURE = /^[0-9a-f]{32}$/;

export function dropSelfHostedThinking(req: ModelRequest): ModelRequest {
  let changed = false;
  const messages = req.messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const content = m.content.filter((b) => {
      const drop = b.type === "thinking" && typeof b.signature === "string" && SELF_HOSTED_SIGNATURE.test(b.signature);
      if (drop) changed = true;
      return !drop;
    });
    // An assistant message can't be empty; keep a placeholder if thinking was all it had.
    return { ...m, content: content.length ? content : [{ type: "text", text: "(thinking omitted)" }] };
  });
  return changed ? { ...req, messages } : req;
}

/**
 * A model served by vLLM's Anthropic-compatible Messages endpoint, for
 * example on a Vast.ai GPU. Same SDK as Claude, different base URL.
 */
export class SelfHostedUpstream implements Upstream {
  private readonly client: Anthropic;

  constructor(baseURL: string, token?: string) {
    // No retries and a short timeout to the first byte: when the box is off,
    // the turn should move to Claude quickly rather than wait.
    this.client = new Anthropic({
      baseURL,
      apiKey: null,
      authToken: token || "none",
      maxRetries: 0,
      timeout: 20_000,
    });
  }

  async stream(params: UpstreamParams, signal: AbortSignal) {
    try {
      const body = { ...toSelfHostedParams(params), stream: true };
      return (await this.client.messages.create(body as never, { signal })) as unknown as AsyncIterable<StreamEvent>;
    } catch (err) {
      throw mapUpstreamError(err);
    }
  }

  /** vLLM's prefix cache warms itself; there's nothing to prewarm. */
  async prewarm(): Promise<BetaUsage> {
    return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as BetaUsage;
  }
}
