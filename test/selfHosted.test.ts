import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { ConfigDocSchema } from "../src/config/schema.js";
import { ApiError } from "../src/errors.js";
import { buildParams } from "../src/proxy/upstream.js";
import { dropSelfHostedThinking, toSelfHostedParams } from "../src/proxy/selfHosted.js";
import { authed, db, FakeUpstream, makeApp, readSse, signIn, textReply, turnBody } from "./helpers.js";

const SELF = "self:Qwen/Qwen3.8-27B-FP8";
const VLLM_SIG = "bbf2085369d649d28b8ff42a51309cb2";

const turn = (app: ReturnType<typeof makeApp>["app"], token: string, body: unknown) =>
  app.request("/v1/agent/turn", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

describe("self-hosted model as primary", () => {
  it("the default config is valid", () => {
    expect(ConfigDocSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("serves the turn on the self-hosted model and records it under that model", async () => {
    const selfHosted = new FakeUpstream();
    selfHosted.events = textReply("Hi", { input: 1000, output: 200 });
    const { app, upstream } = makeApp({ selfHosted });
    const s = await signIn(app);
    const body = turnBody();
    const events = await readSse(await turn(app, s.accessToken, body));

    expect(selfHosted.calls).toHaveLength(1);
    expect(upstream.calls).toHaveLength(0);
    const p = selfHosted.calls[0] as unknown as Record<string, unknown>;
    expect(p.model).toBe(SELF);
    expect(p.max_tokens).toBe(16_000);
    // What actually goes to vLLM: no Claude-only fields, Qwen's thinking off for a change.
    const sent = toSelfHostedParams(selfHosted.calls[0]!);
    expect(sent.thinking).toBeUndefined();
    expect(sent.fallbacks).toBeUndefined();
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });

    // Priced like Haiku: $0.10 in, $0.50 out per MTok.
    const expected = 1000 * 0.1 + 200 * 0.5;
    expect(events.at(-1)!.data.costMicros).toBe(expected);
    const [row] = await db()`select model, cost_micros from usage_ledger where run_id = ${body.runId}`;
    expect(row).toMatchObject({ model: SELF, cost_micros: expected });
  });

  it("falls back to Claude when the self-hosted model can't start the turn, without vLLM's thinking", async () => {
    const selfHosted = new FakeUpstream();
    selfHosted.failWith = new ApiError(503, "upstream_unavailable", "down");
    const { app, upstream } = makeApp({ selfHosted });
    const s = await signIn(app);
    const body = turnBody(
      {},
      {
        messages: [
          { role: "user", content: "Add a 5mm fillet" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Use add_feature", signature: VLLM_SIG },
              { type: "tool_use", id: "t1", name: "add_feature", input: {} },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
      },
    );
    const res = await turn(app, s.accessToken, body);
    expect(res.status).toBe(200);
    await readSse(res);

    expect(upstream.calls).toHaveLength(1);
    const p = upstream.calls[0] as unknown as { model: string; messages: { content: { type: string }[] }[] };
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.messages[1]!.content.map((b) => b.type)).toEqual(["tool_use"]);
    const [row] = await db()`select model from usage_ledger where run_id = ${body.runId}`;
    expect(row!.model).toBe("claude-opus-5-5");
  });

  it("goes straight to Claude for plans outside the list, or when switched off", async () => {
    for (const selfConfig of [
      { ...DEFAULT_CONFIG.selfHosted!, plans: ["internal"] },
      { ...DEFAULT_CONFIG.selfHosted!, enabled: false },
    ]) {
      const selfHosted = new FakeUpstream();
      const { app, upstream } = makeApp({ selfHosted, config: { ...DEFAULT_CONFIG, selfHosted: selfConfig } });
      const s = await signIn(app); // "beta" plan
      await readSse(await turn(app, s.accessToken, turnBody()));
      expect(selfHosted.calls).toHaveLength(0);
      expect(upstream.calls).toHaveLength(1);
    }
  });

  it("goes to Claude when no self-hosted server is configured", async () => {
    const { app, upstream } = makeApp({ selfHosted: null });
    const s = await signIn(app);
    await readSse(await turn(app, s.accessToken, turnBody()));
    expect((upstream.calls[0] as unknown as { model: string }).model).toBe("claude-opus-5-5");
  });

  it("keepwarm does nothing and charges nothing when the self-hosted model serves the turn", async () => {
    const selfHosted = new FakeUpstream();
    const { app, upstream } = makeApp({ selfHosted });
    const s = await signIn(app);
    const res = await app.request("/v1/agent/keepwarm", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(turnBody()) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ costMicros: 0, creditsCharged: 0 });
    expect(upstream.calls).toHaveLength(0);
    expect(selfHosted.calls).toHaveLength(0);
  });
});

describe("request shaping for vLLM", () => {
  it("drops Claude-only fields, cache_control, redacted thinking and the model prefix", () => {
    const profile = DEFAULT_CONFIG.selfHosted!.taskProfiles.change!;
    const params = buildParams(
      { ...profile, thinkingUpdates: true, refusalFallback: true, taskBudgetTokens: 20_000 },
      {
        system: [{ type: "text", text: "You are Keel.", cache_control: { type: "ephemeral" } }],
        tools: [{ name: "add_feature", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }, { type: "text", text: "ok" }] },
        ],
      },
    );
    const out = toSelfHostedParams(params);
    expect(out.model).toBe("Qwen/Qwen3.8-27B-FP8");
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: true });
    for (const k of ["betas", "output_config", "thinking", "fallbacks"]) expect(out[k]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("cache_control");
    expect(JSON.stringify(out)).not.toContain("redacted_thinking");
  });

  it("keeps Claude's own thinking blocks when moving a run to Claude", () => {
    const claudeSig = "EqQBCkgIARABGAIiQL".padEnd(120, "x");
    const req = {
      messages: [
        { role: "user" as const, content: "hi" },
        { role: "assistant" as const, content: [{ type: "thinking", thinking: "a", signature: claudeSig }, { type: "text", text: "ok" }] },
        { role: "assistant" as const, content: [{ type: "thinking", thinking: "b", signature: VLLM_SIG }] },
      ],
    };
    const out = dropSelfHostedThinking(req);
    expect(out.messages[1]!.content).toHaveLength(2);
    expect(out.messages[2]!.content).toEqual([{ type: "text", text: "(thinking omitted)" }]);
  });
});

describe("thinking per task type", () => {
  it("is on for fixes and reviews, off for changes and chat", () => {
    const req = { messages: [{ role: "user" as const, content: "hi" }] };
    const sh = DEFAULT_CONFIG.selfHosted!.taskProfiles;
    expect(toSelfHostedParams(buildParams(sh.fix!, req)).chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(toSelfHostedParams(buildParams(sh.change!, req)).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(toSelfHostedParams(buildParams(sh.ask!, req)).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe("env", () => {
  it("treats empty self-hosted variables as unset", async () => {
    const { loadEnv } = await import("../src/env.js");
    const base = {
      DATABASE_URL: "postgres://x",
      ANTHROPIC_API_KEY: "k",
      ACCESS_TOKEN_SECRET: "x".repeat(32),
      PROJECT_HASH_SALT: "y".repeat(16),
      APPLE_CLIENT_ID: "app",
    };
    const env = loadEnv({ ...base, SELF_HOSTED_BASE_URL: "", SELF_HOSTED_TOKEN: "" });
    expect(env.SELF_HOSTED_BASE_URL).toBeUndefined();
    expect(env.SELF_HOSTED_TOKEN).toBeUndefined();
    expect(loadEnv({ ...base, SELF_HOSTED_BASE_URL: "http://1.2.3.4:41234" }).SELF_HOSTED_BASE_URL).toBe("http://1.2.3.4:41234");
  });
});

describe("forced tool choice", () => {
  const tool = { name: "propose_changes", input_schema: { type: "object" } };
  const forced = { type: "tool" as const, name: "propose_changes" };

  it("reaches the self-hosted model, and is dropped when the turn falls back to a thinking Claude", async () => {
    const selfHosted = new FakeUpstream();
    selfHosted.failWith = new ApiError(503, "upstream_unavailable", "down");
    const { app, upstream } = makeApp({ selfHosted });
    const s = await signIn(app);
    const res = await turn(app, s.accessToken, turnBody({}, { tools: [tool], tool_choice: forced }));
    expect(res.status).toBe(200);
    await readSse(res);

    const toSelf = toSelfHostedParams(selfHosted.calls[0]!);
    expect(toSelf.tool_choice).toEqual(forced);
    expect((upstream.calls[0] as unknown as Record<string, unknown>).tool_choice).toBeUndefined();
  });

  it("is kept for Claude when the profile doesn't think", () => {
    const profile = { ...DEFAULT_CONFIG.taskProfiles.chore, thinkingUpdates: false };
    const p = buildParams(profile, { tools: [tool], tool_choice: forced, messages: [{ role: "user", content: "x" }] });
    expect((p as unknown as Record<string, unknown>).tool_choice).toEqual(forced);
  });

  it("rejects a choice naming a tool that isn't sent", async () => {
    const { app } = makeApp({ selfHosted: new FakeUpstream() });
    const s = await signIn(app);
    const res = await turn(app, s.accessToken, turnBody({}, { tools: [tool], tool_choice: { type: "tool", name: "nope" } }));
    expect(res.status).toBe(422);
  });
});
