import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { toolHash } from "../src/proxy/toolHash.js";
import { authed, db, FakeUpstream, makeApp, readSse, signIn, textReply, turnBody } from "./helpers.js";

const turn = (app: ReturnType<typeof makeApp>["app"], token: string, body: unknown) =>
  app.request("/v1/agent/turn", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("POST /agent/turn", () => {
  it("streams Claude's events unchanged and ends with keel.usage", async () => {
    const { app, upstream } = makeApp();
    upstream.events = textReply("Done", { input: 1000, output: 500, cacheWrite: 2000, cacheRead: 10_000 });
    const s = await signIn(app);
    const body = turnBody();
    const res = await turn(app, s.accessToken, body);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
      "keel.usage",
    ]);
    expect(events[2]!.data).toEqual(upstream.events[2]);

    // Opus 5.5: $4 in, $20 out, $5 5m cache write, $0.20 cache read per MTok.
    const expected = 1000 * 4 + 500 * 20 + 2000 * 5 + 10_000 * 0.2;
    const usage = events.at(-1)!.data;
    expect(usage.costMicros).toBe(expected);
    expect(usage.outputTokens).toBe(500);

    const [row] = await db()`select * from usage_ledger where run_id = ${body.runId}`;
    expect(row).toMatchObject({
      account_id: s.account.id,
      device_id: s.deviceId,
      task_type: "change",
      model: "claude-opus-5-5",
      input_tokens: 1000,
      cache_write_tokens: 2000,
      cache_read_tokens: 10_000,
      output_tokens: 500,
      cost_micros: expected,
      stop_reason: "end_turn",
    });
    expect(row!.project_hash).not.toContain("proj-1");
  });

  it("sets model, effort, limits, thinking and fallback from the profile", async () => {
    const { app, upstream } = makeApp();
    const s = await signIn(app);
    // The app tries to pick its own model and settings; those fields are dropped.
    const body = turnBody({}, { model: "claude-fable-5-1", thinking: { type: "disabled" }, fallbacks: [] });
    await readSse(await turn(app, s.accessToken, body));
    const p = upstream.calls[0] as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(32_000);
    expect(p.output_config).toEqual({ effort: "medium", task_budget: { type: "tokens", total: 60_000 } });
    expect(p.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(
      expect.arrayContaining(["task-budgets-2026-03-13", "thinking-display-updates-2026-08-18", "server-side-fallback-2026-07-01"]),
    );
  });

  it("lets the app lower effort but not raise it", async () => {
    const { app, upstream } = makeApp();
    const s = await signIn(app);
    await readSse(await turn(app, s.accessToken, turnBody({ effort: "low" })));
    expect((upstream.calls[0] as unknown as { output_config: { effort: string } }).output_config.effort).toBe("low");
    const res = await turn(app, s.accessToken, turnBody({ effort: "max" }));
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("outside_task_profile");
  });

  it("uses Haiku with no fallback for chores", async () => {
    const { app, upstream } = makeApp();
    const s = await signIn(app);
    await readSse(await turn(app, s.accessToken, turnBody({ taskType: "chore" })));
    const p = upstream.calls[0] as unknown as Record<string, unknown>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.fallbacks).toBeUndefined();
    expect(p.max_tokens).toBe(1_000);
  });

  it("rejects server tools, too many breakpoints, too many images and batch-only task types", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    const serverTool = turnBody({}, { tools: [{ type: "web_search_20260209", name: "web_search" }] });
    expect((await turn(app, s.accessToken, serverTool)).status).toBe(422);

    const cc = { type: "ephemeral" };
    const breakpoints = turnBody(
      {},
      {
        system: Array.from({ length: 5 }, (_, i) => ({ type: "text", text: `s${i}`, cache_control: cc })),
      },
    );
    expect((await turn(app, s.accessToken, breakpoints)).status).toBe(422);

    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const images = turnBody({}, { messages: [{ role: "user", content: [img, img, img, img] }] });
    expect((await turn(app, s.accessToken, images)).status).toBe(413);

    expect((await turn(app, s.accessToken, turnBody({ taskType: "overnight_review" }))).status).toBe(422);
  });

  it("rejects bodies over the size limit", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    const big = turnBody({}, { messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }] });
    const res = await turn(app, s.accessToken, big);
    expect(res.status).toBe(413);
  });

  it("rejects unknown top-level fields", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    expect((await turn(app, s.accessToken, { ...turnBody(), model: "claude-fable-5-1" })).status).toBe(400);
  });

  it("enforces the tool allowlist by name and schema hash", async () => {
    const tool = { name: "add_feature", input_schema: { type: "object", properties: {} } };
    const config = { ...DEFAULT_CONFIG, toolAllowlist: { change: { add_feature: toolHash(tool) } } };
    const { app } = makeApp({ config });
    const s = await signIn(app);
    expect((await turn(app, s.accessToken, turnBody())).status).toBe(200);
    const changed = turnBody({}, { tools: [{ ...tool, input_schema: { type: "object", properties: { x: {} } } }] });
    expect((await turn(app, s.accessToken, changed)).status).toBe(422);
    const other = turnBody({}, { tools: [{ name: "delete_everything", input_schema: {} }] });
    expect((await turn(app, s.accessToken, other)).status).toBe(422);
  });

  it("ends the 9th turn of a run with keel.error", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    const runId = "run-cap";
    for (let i = 0; i < 8; i++) await readSse(await turn(app, s.accessToken, turnBody({ runId, turnIndex: i })));
    const events = await readSse(await turn(app, s.accessToken, turnBody({ runId, turnIndex: 8 })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "keel.error", data: { code: "run_limit_reached", limit: "turns" } });
  });

  it("ends a run that passed about $1", async () => {
    const { app, upstream } = makeApp();
    upstream.events = textReply("big", { input: 200_000, output: 20_000 }); // $0.80 + $0.40
    const s = await signIn(app);
    await readSse(await turn(app, s.accessToken, turnBody({ runId: "run-cost" })));
    const events = await readSse(await turn(app, s.accessToken, turnBody({ runId: "run-cost", turnIndex: 1 })));
    expect(events[0]).toMatchObject({ event: "keel.error", data: { limit: "cost" } });
  });

  it("warns with 20% of the credits left and returns 402 when they run out", async () => {
    // 15 credits = 100,000 micro dollars.
    const config = { ...DEFAULT_CONFIG, plans: { ...DEFAULT_CONFIG.plans, beta: { name: "Tiny", tier: "pro" as const, monthlyCredits: 15 } } };
    const { app, upstream } = makeApp({ config });
    upstream.events = textReply("x", { input: 0, output: 4_500 }); // 90,000 micros
    const s = await signIn(app);
    const events = await readSse(await turn(app, s.accessToken, turnBody()));
    expect(events.at(-1)).toMatchObject({ event: "keel.warning", data: { code: "credits_low", creditsLeft: 1 } });
    expect(events.at(-2)!.data).toMatchObject({ creditsCharged: 14, creditsLeft: 1, allowanceUsedPercent: 90 });

    await readSse(await turn(app, s.accessToken, turnBody())); // goes past 100%, allowed to finish
    const res = await turn(app, s.accessToken, turnBody());
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe("credits_exhausted");
  });

  it("prices a fallback-served turn at each model's rate", async () => {
    const { app, upstream } = makeApp();
    upstream.events = textReply(
      "ok",
      { input: 1000, output: 100 },
      {
        iterations: [
          { type: "message", input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          {
            type: "fallback_message",
            model: "claude-opus-5",
            input_tokens: 1000,
            output_tokens: 90,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      },
    );
    const s = await signIn(app);
    const body = turnBody();
    const events = await readSse(await turn(app, s.accessToken, body));
    const expected = 1000 * 4 + 10 * 20 + (1000 * 5 + 90 * 25);
    expect(events.at(-1)!.data).toMatchObject({ costMicros: expected, servedModel: "claude-opus-5" });
  });

  it("passes refusals through unchanged", async () => {
    const { app, upstream } = makeApp();
    upstream.events = textReply("", { input: 100, output: 0 }, { stopReason: "refusal" });
    const s = await signIn(app);
    const body = turnBody();
    const events = await readSse(await turn(app, s.accessToken, body));
    expect(events.find((e) => e.event === "message_delta")!.data).toMatchObject({ delta: { stop_reason: "refusal" } });
    const [row] = await db()`select stop_reason from usage_ledger where run_id = ${body.runId}`;
    expect(row!.stop_reason).toBe("refusal");
  });

  it("returns 503 when Claude is overloaded before the stream starts", async () => {
    const { app, upstream } = makeApp();
    const { mapUpstreamError } = await import("../src/proxy/upstream.js");
    upstream.failWith = mapUpstreamError(new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()));
    const s = await signIn(app);
    const res = await turn(app, s.accessToken, turnBody());
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("upstream_unavailable");
  });

  it("sends keel.error when the stream breaks midway and still records usage", async () => {
    const upstream = new FakeUpstream();
    const { app } = makeApp({ upstream });
    const events = textReply("partial", { input: 500, output: 50 }).slice(0, 3);
    upstream.stream = async () =>
      (async function* () {
        for (const e of events) yield e;
        throw new Anthropic.APIConnectionError({ message: "reset" });
      })();
    const s = await signIn(app);
    const body = turnBody();
    const out = await readSse(await turn(app, s.accessToken, body));
    expect(out.find((e) => e.event === "keel.error")).toBeDefined();
    const [row] = await db()`select stop_reason, input_tokens from usage_ledger where run_id = ${body.runId}`;
    expect(row).toMatchObject({ stop_reason: "upstream_error", input_tokens: 500 });
  });
});

describe("POST /agent/keepwarm", () => {
  it("sends a zero-output request and records it", async () => {
    const { app, upstream } = makeApp();
    const s = await signIn(app);
    const body = turnBody();
    const res = await app.request("/v1/agent/keepwarm", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outputTokens: 0, cacheWriteTokens: 5000 });
    expect((upstream.calls[0] as unknown as { model: string }).model).toBe("claude-opus-5-5");
    const [row] = await db()`select kind from usage_ledger where run_id = ${body.runId}`;
    expect(row!.kind).toBe("keepwarm");
  });
});
