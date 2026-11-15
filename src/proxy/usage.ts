import type { ConfigDoc, ModelPrice } from "../config/schema.js";
import { log } from "../logger.js";

export interface TokenUsage {
  inputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
});

export interface PricedUsage extends TokenUsage {
  costMicros: number;
  /** Set when a server-side fallback model served the turn. */
  servedModel: string | null;
}

type UsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  iterations?: Array<UsageLike & { type?: string; model?: string }> | null;
};

function toTokens(u: UsageLike): TokenUsage {
  const write = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? write - w1h;
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(0, w5m),
    cacheWrite1hTokens: w1h,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
}

function priceOf(config: ConfigDoc, model: string): ModelPrice {
  const p = config.prices[model];
  if (p) return p;
  // Never undercharge for a model that isn't priced: use the dearest one.
  log.warn("price_missing", { model });
  return Object.values(config.prices).reduce((a, b) => (b.output > a.output ? b : a));
}

/**
 * The most a turn can cost, for holding credits back while it runs: every
 * input token priced as a 1-hour cache write (the dearest input) and the full
 * output cap.
 */
export function worstCaseMicros(config: ConfigDoc, model: string, inputTokens: number, maxOutputTokens: number): number {
  const p = priceOf(config, model);
  return Math.ceil(inputTokens * Math.max(p.input, p.cacheWrite5m, p.cacheWrite1h) + maxOutputTokens * p.output);
}

/** Cost in micro dollars. Prices are USD per million tokens, i.e. micro dollars per token. */
export function costMicros(t: TokenUsage, p: ModelPrice): number {
  return (
    t.inputTokens * p.input +
    t.cacheWrite5mTokens * p.cacheWrite5m +
    t.cacheWrite1hTokens * p.cacheWrite1h +
    t.cacheReadTokens * p.cacheRead +
    t.outputTokens * p.output
  );
}

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
  cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/**
 * Prices a usage block as Anthropic returned it. When `iterations` shows a
 * fallback model served the turn, each iteration is priced at its own model
 * (declined hops and compaction at the requested model); otherwise the
 * top-level totals are priced at the requested model.
 */
export function priceUsage(config: ConfigDoc, requestedModel: string, usage: UsageLike): PricedUsage {
  const iterations = usage.iterations ?? [];
  const fallback = iterations.find((i) => i.type === "fallback_message");
  if (fallback) {
    let total = emptyUsage();
    let cost = 0;
    for (const it of iterations) {
      if (it.type === "advisor_message") continue; // not used by Keel
      const t = toTokens(it);
      const model = it.type === "fallback_message" && it.model ? it.model : requestedModel;
      cost += costMicros(t, priceOf(config, model));
      total = add(total, t);
    }
    return { ...total, costMicros: Math.ceil(cost), servedModel: fallback.model ?? null };
  }
  const t = toTokens(usage);
  let cost = costMicros(t, priceOf(config, requestedModel));
  // Compaction iterations are billed but not in the top-level fields.
  for (const it of iterations) {
    if (it.type === "compaction") cost += costMicros(toTokens(it), priceOf(config, requestedModel));
  }
  return { ...t, costMicros: Math.ceil(cost), servedModel: null };
}

/**
 * Characters of streamed output per token, for estimating output when the
 * final usage never arrives. Real text runs about 4; 3 errs towards charging
 * what Anthropic billed rather than less.
 */
export const CHARS_PER_OUTPUT_TOKEN_ESTIMATE = 3;

/**
 * Thinking streams as a summary ("display: updates"), far shorter than the
 * thinking tokens billed, so when thinking was seen the estimate is at least
 * this many tokens per second of streaming (a slow rate for Claude's output).
 */
export const THINKING_TOKENS_PER_SECOND_FLOOR = 40;

/**
 * Collects the usage block from a stream. `message_start` carries the input
 * side; each `message_delta` carries cumulative totals, so the latest non-null
 * value of each field wins.
 *
 * Output tokens are only reported in `message_delta`, at the end. When the
 * stream stops before that (the app disconnected, or the stream broke),
 * Anthropic has still billed what it generated, so the output is estimated
 * from the text, thinking and tool input streamed so far, and, when the model
 * was thinking, from how long it streamed. The estimate never goes above the
 * turn's output cap.
 */
export class StreamUsage {
  private usage: UsageLike = {};
  private finalOutput = false;
  private streamedChars = 0;
  private sawThinking = false;
  private firstAt: number | null = null;
  stopReason: string | null = null;

  constructor(
    private readonly maxOutputTokens = Infinity,
    private readonly clock: () => number = Date.now,
  ) {}

  observe(event: {
    type: string;
    message?: { usage?: UsageLike };
    usage?: UsageLike;
    delta?: { stop_reason?: string | null; type?: string; text?: string; thinking?: string; partial_json?: string; signature?: string };
  }) {
    if (this.firstAt === null) this.firstAt = this.clock();
    if (event.type === "message_start" && event.message?.usage) this.merge(event.message.usage);
    if (event.type === "content_block_start" && (event as { content_block?: { type?: string } }).content_block?.type?.includes("thinking")) {
      this.sawThinking = true;
    }
    if (event.type === "content_block_delta" && event.delta) {
      const d = event.delta;
      this.streamedChars += (d.text?.length ?? 0) + (d.thinking?.length ?? 0) + (d.partial_json?.length ?? 0);
    }
    if (event.type === "message_delta") {
      if (event.usage) {
        this.merge(event.usage);
        if (typeof event.usage.output_tokens === "number") this.finalOutput = true;
      }
      if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason;
    }
  }

  private merge(u: UsageLike) {
    for (const [k, v] of Object.entries(u)) {
      if (v !== null && v !== undefined) (this.usage as Record<string, unknown>)[k] = v;
    }
  }

  /** True when the stream ended before its final usage, so output tokens are an estimate. */
  get outputEstimated(): boolean {
    return !this.finalOutput;
  }

  get raw(): UsageLike {
    if (this.finalOutput) return this.usage;
    let estimate = Math.ceil(this.streamedChars / CHARS_PER_OUTPUT_TOKEN_ESTIMATE);
    if (this.sawThinking && this.firstAt !== null) {
      estimate = Math.max(estimate, Math.ceil(((this.clock() - this.firstAt) / 1000) * THINKING_TOKENS_PER_SECOND_FLOOR));
    }
    estimate = Math.min(estimate, this.maxOutputTokens);
    return { ...this.usage, output_tokens: Math.max(this.usage.output_tokens ?? 0, estimate) };
  }
}
