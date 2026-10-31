import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageStreamParams,
  MessageCreateParamsNonStreaming,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort, TaskProfile } from "../config/schema.js";
import { ApiError } from "../errors.js";
import type { ModelRequest } from "./request.js";

export type UpstreamParams = Omit<BetaMessageStreamParams, "stream">;
export type StreamEvent = BetaRawMessageStreamEvent;

/** Claude's Messages API, behind an interface so tests don't call Anthropic. */
export interface Upstream {
  /**
   * Starts a streamed request. Resolves once Anthropic has accepted it (the
   * SDK retries connection errors, 429 and 5xx up to this point and never
   * after), so failures here can still be returned as plain HTTP errors.
   */
  stream(params: UpstreamParams, signal: AbortSignal): Promise<AsyncIterable<StreamEvent>>;
  /** A max_tokens 0 request: writes the cache, produces no output. */
  prewarm(params: UpstreamParams): Promise<BetaUsage>;
}

const BETA_TASK_BUDGETS = "task-budgets-2026-03-13";
const BETA_THINKING_UPDATES = "thinking-display-updates-2026-08-18";
const BETA_FALLBACK = "server-side-fallback-2026-07-01";

/** Turns a checked request and its task profile into Messages API parameters. */
export function buildParams(
  profile: TaskProfile,
  req: ModelRequest,
  opts: { effort?: Effort; maxOutputTokens?: number } = {},
): UpstreamParams {
  const betas: string[] = [];
  const outputConfig: Record<string, unknown> = { effort: opts.effort ?? profile.effort };
  if (profile.taskBudgetTokens) {
    outputConfig.task_budget = { type: "tokens", total: profile.taskBudgetTokens };
    betas.push(BETA_TASK_BUDGETS);
  }
  const params: Record<string, unknown> = {
    model: profile.model,
    max_tokens: opts.maxOutputTokens ?? profile.maxOutputTokens,
    messages: req.messages,
    output_config: outputConfig,
  };
  if (req.system !== undefined) params.system = req.system;
  if (req.tools?.length) params.tools = req.tools;
  if (profile.thinkingUpdates) {
    params.thinking = { type: "adaptive", display: "updates" };
    betas.push(BETA_THINKING_UPDATES);
  }
  if (profile.refusalFallback) {
    // Routes by refusal category; a refusal that still stands is passed to
    // the app unchanged so the pane can show its Declined state.
    params.fallbacks = "default";
    betas.push(BETA_FALLBACK);
  }
  if (betas.length) params.betas = betas;
  return params as unknown as UpstreamParams;
}

/** Maps an Anthropic error to the service's own error codes. */
export function mapUpstreamError(err: unknown): ApiError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 413) return new ApiError(413, "request_too_large", "Request too large for the model");
    if (status === 429 || status === 529 || status >= 500 || status === 0) {
      return new ApiError(503, "upstream_unavailable", "Claude is unavailable, retry shortly", { upstreamStatus: status });
    }
    return new ApiError(502, "upstream_error", "Claude rejected the request", { upstreamStatus: status });
  }
  return new ApiError(502, "upstream_error", "Could not reach Claude");
}

export class AnthropicUpstream implements Upstream {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async stream(params: UpstreamParams, signal: AbortSignal) {
    try {
      return await this.client.beta.messages.create({ ...params, stream: true }, { signal });
    } catch (err) {
      throw mapUpstreamError(err);
    }
  }

  async prewarm(params: UpstreamParams) {
    try {
      const msg = await this.client.beta.messages.create({
        ...(params as unknown as MessageCreateParamsNonStreaming),
        max_tokens: 0,
        stream: false,
      } as never);
      return (msg as { usage: BetaUsage }).usage;
    } catch (err) {
      throw mapUpstreamError(err);
    }
  }
}
