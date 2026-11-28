import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { ConfigDocSchema, type ConfigDoc } from "../src/config/schema.js";
import { ApiError } from "../src/errors.js";
import { buildParams, type StreamEvent } from "../src/proxy/upstream.js";
import { effectiveTier, routeTurn, tierProfile } from "../src/proxy/routing.js";
import { markSelfHostedDown, selfHostedIsDown } from "../src/proxy/selfHosted.js";
import { StreamUsage } from "../src/proxy/usage.js";
import { authed, db, FakeUpstream, makeApp, readSse, signIn, textReply, turnBody } from "./helpers.js";

const SELF = "self:Qwen/Qwen3.8-27B-FP8";

const routingOn = (extra: Partial<NonNullable<ConfigDoc["routing"]>> = {}): ConfigDoc => ({
  ...DEFAULT_CONFIG,
  routing: { ...DEFAULT_CONFIG.routing!, tiers: true, ...extra },
});

const turn = (app: ReturnType<typeof makeApp>["app"], token: string, body: unknown) =>
  app.request("/v1/agent/turn", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

/** A reply that calls one tool, for the ledger's tool_called column. */
function toolReply(name: string): StreamEvent[] {
  const [start, , , , ...end] = textReply("", { input: 500, output: 80 });
  return [
    start!,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
    { type: "content_block_stop", index: 0 },
    ...end,
  ] as StreamEvent[];
}

describe("tiered routing", () => {
  it("a stored config from before auto and build still parses, using change's profile for both", () => {
    const { auto: _a, build: _b, ...older } = DEFAULT_CONFIG.taskProfiles;
    const { routing: _r, ...doc } = { ...DEFAULT_CONFIG, taskProfiles: older };
    const parsed = ConfigDocSchema.parse(doc);
    expect(parsed.taskProfiles.auto).toEqual(DEFAULT_CONFIG.taskProfiles.change);
    expect(parsed.taskProfiles.build).toEqual(DEFAULT_CONFIG.taskProfiles.change);
    expect(parsed.routing).toBeUndefined();
  });

  it("ignores the tier while routing is off, and raises it to the type's floor when on", () => {
    expect(effectiveTier(DEFAULT_CONFIG, { taskType: "auto", tier: "top" })).toBeNull();
    const on = routingOn({ floors: { build: "mid" } });
    expect(effectiveTier(on, { taskType: "auto", tier: "cheap" })).toBe("cheap");
    expect(effectiveTier(on, { taskType: "build", tier: "cheap" })).toBe("mid");
    expect(effectiveTier(on, { taskType: "build", tier: "top" })).toBe("top");
    expect(effectiveTier(on, { taskType: "auto" })).toBeNull();
  });

  it("mid and top go straight to their Claude model, keeping the type's output cap", () => {
    const on = routingOn();
    const type = DEFAULT_CONFIG.taskProfiles.build;
    const self = DEFAULT_CONFIG.selfHosted!.taskProfiles.build!;
    const mid = routeTurn(on, { taskType: "build", tier: "mid" }, type, self);
    expect(mid.selfProfile).toBeNull();
    expect(mid.profile).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", maxOutputTokens: type.maxOutputTokens });
    const top = routeTurn(on, { taskType: "build", tier: "top" }, type, self);
    expect(top.profile).toMatchObject({ model: "claude-opus-5-5", effort: "high", thinkingUpdates: true });
    const cheap = routeTurn(on, { taskType: "build", tier: "cheap" }, type, self);
    expect(cheap).toMatchObject({ tier: "cheap", profile: type, selfProfile: self });
  });

  it("a Haiku tier has no updates display or refusal fallback", () => {
    const p = tierProfile(DEFAULT_CONFIG.taskProfiles.change, { model: "claude-haiku-5-5", effort: "low" });
    expect(p).toMatchObject({ thinkingUpdates: false, refusalFallback: false });
  });

  it("never sends a forced tool_choice to Opus 5.5 or Sonnet 5.5, even with thinking updates off", () => {
    const req = {
      messages: [{ role: "user" as const, content: "x" }],
      tools: [{ name: "propose_changes", input_schema: { type: "object" } }],
      tool_choice: { type: "any" as const },
    };
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      const params = buildParams({ ...DEFAULT_CONFIG.taskProfiles.change, model, thinkingUpdates: false }, req);
      expect((params as { tool_choice?: unknown }).tool_choice).toBeUndefined();
    }
    const haiku = buildParams(DEFAULT_CONFIG.taskProfiles.auto, req);
    expect((haiku as { tool_choice?: unknown }).tool_choice).toEqual({ type: "any" });
  });

  it("remembers the last tool the model called", () => {
    const usage = new StreamUsage();
    for (const e of toolReply("propose_parts")) usage.observe(e as never);
    expect(usage.toolCalled).toBe("propose_parts");
  });

  it("skips a self-hosted model that just failed, until its cooldown ends", () => {
    const up = {};
    expect(selfHostedIsDown(up)).toBe(false);
    markSelfHostedDown(up, 60, 1_000);
    expect(selfHostedIsDown(up, 30_000)).toBe(true);
    expect(selfHostedIsDown(up, 62_000)).toBe(false);
  });

  it("serves a top-tier turn on Opus without trying Qwen, and records tier, tool and escalation", async () => {
    const selfHosted = new FakeUpstream();
    const { app, upstream } = makeApp({ selfHosted, config: routingOn() });
    upstream.events = toolReply("propose_changes");
    const s = await signIn(app);
    const body = turnBody({ taskType: "build", tier: "top", escalatedFrom: "cheap" });
    const events = await readSse(await turn(app, s.accessToken, body));

    expect(selfHosted.calls).toHaveLength(0);
    expect((upstream.calls[0] as unknown as { model: string }).model).toBe("claude-opus-5-5");
    expect(events.at(-1)!.data.tier).toBe("top");
    const [row] = await db()`select task_type, tier, tool_called, escalated_from from usage_ledger where run_id = ${body.runId}`;
    expect(row).toMatchObject({ task_type: "build", tier: "top", tool_called: "propose_changes", escalated_from: "cheap" });
  });

  it("serves a cheap-tier auto turn on Qwen", async () => {
    const selfHosted = new FakeUpstream();
    selfHosted.events = textReply("A bolt is a fastener.", { input: 800, output: 40 });
    const { app, upstream } = makeApp({ selfHosted, config: routingOn() });
    const s = await signIn(app);
    const body = turnBody({ taskType: "auto", tier: "cheap" });
    await readSse(await turn(app, s.accessToken, body));
    expect(upstream.calls).toHaveLength(0);
    expect((selfHosted.calls[0] as unknown as { model: string }).model).toBe(SELF);
    const [row] = await db()`select tier, tool_called from usage_ledger where run_id = ${body.runId}`;
    expect(row).toMatchObject({ tier: "cheap", tool_called: null });
  });

  it("after Qwen fails once, the next cheap turn goes straight to Claude without waiting for it", async () => {
    const selfHosted = new FakeUpstream();
    selfHosted.failWith = new ApiError(503, "upstream_unavailable", "down");
    const { app, upstream } = makeApp({ selfHosted, config: routingOn() });
    const s = await signIn(app);
    await readSse(await turn(app, s.accessToken, turnBody({ taskType: "auto", tier: "cheap" })));
    await readSse(await turn(app, s.accessToken, turnBody({ taskType: "auto", tier: "cheap" })));
    expect(selfHosted.calls).toHaveLength(1);
    expect(upstream.calls).toHaveLength(2);
    expect((upstream.calls[1] as unknown as { model: string }).model).toBe("claude-haiku-5-5");
  });

  it("without a tier, a turn routes exactly as before", async () => {
    const selfHosted = new FakeUpstream();
    const { app, upstream } = makeApp({ selfHosted, config: routingOn() });
    const s = await signIn(app);
    const body = turnBody();
    await readSse(await turn(app, s.accessToken, body));
    expect(selfHosted.calls).toHaveLength(1);
    expect(upstream.calls).toHaveLength(0);
    const [row] = await db()`select tier from usage_ledger where run_id = ${body.runId}`;
    expect(row!.tier).toBeNull();
  });
});
