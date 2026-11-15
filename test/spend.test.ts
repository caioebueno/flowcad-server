import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { ConfigDoc } from "../src/config/schema.js";
import type { StreamEvent } from "../src/proxy/upstream.js";
import { authed, db, FakeUpstream, makeApp, readSse, signIn, textReply, turnBody } from "./helpers.js";

type App = ReturnType<typeof makeApp>["app"];
const turn = (app: App, token: string, body: unknown = turnBody()) =>
  app.request("/v1/agent/turn", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

/** An upstream whose replies all wait until `release()`, so turns overlap like real long generations. */
function gatedUpstream(events: StreamEvent[]) {
  const upstream = new FakeUpstream();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  upstream.stream = async () =>
    (async function* () {
      yield events[0]!;
      await gate;
      for (const e of events.slice(1)) yield e;
    })();
  return { upstream, release };
}

const withLimits = (limits: Partial<ConfigDoc["limits"]>): ConfigDoc => ({ ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, ...limits } });

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;

describe("credits under concurrent turns", () => {
  it("lets only one turn run on the last micro dollar, not every turn sent at once", async () => {
    // Plenty of concurrency allowed, so only the credit reservation can stop the overspend.
    const { upstream, release } = gatedUpstream(textReply("x", { input: 150_000, output: 32_000 }));
    const { app } = makeApp({ upstream, config: withLimits({ concurrentRuns: 100, turnsPerMinute: 100 }) });
    const s = await signIn(app);
    const limit = Math.round(2000 * (1_000_000 / 150));
    await db()`insert into allowances (account_id, period_start, month, limit_micros, used_micros)
      values (${s.account.id}, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC', date_trunc('month', now())::date, ${limit}, ${limit - 1})`;

    const responses = await Promise.all(Array.from({ length: 25 }, () => turn(app, s.accessToken)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.filter((x) => x === 402)).toHaveLength(24);
    for (const r of responses.filter((x) => x.status === 402)) expect((await errorOf(r)).code).toBe("credits_exhausted");

    release();
    await Promise.all(responses.filter((r) => r.status === 200).map(readSse));
    const [a] = await db()<{ used_micros: number }[]>`select used_micros from allowances where account_id = ${s.account.id}`;
    // One turn's overrun ($1.24 here), not 25 of them.
    expect(a!.used_micros - limit).toBeLessThan(1_300_000);
    expect((await turn(app, s.accessToken)).status).toBe(402);
  });

  it("holds the turn in flight back from the balance and settles it to the real cost", async () => {
    const { upstream, release } = gatedUpstream(textReply("x", { input: 1_000, output: 200 }));
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const res = await turn(app, s.accessToken);
    const [held] = await db()<{ stop_reason: string; cost_micros: number }[]>`
      select stop_reason, cost_micros from usage_ledger where account_id = ${s.account.id}`;
    expect(held).toMatchObject({ stop_reason: "in_flight" });
    expect(held!.cost_micros).toBeGreaterThan(32_000 * 20); // the profile's whole output cap (32K at $20/M), plus input
    // A turn in flight isn't shown as use.
    const usage = (await (await app.request("/v1/usage", { headers: authed(s.accessToken) })).json()) as { rows: unknown[] };
    expect(usage.rows).toEqual([]);

    release();
    await readSse(res);
    const rows = await db()<{ stop_reason: string; cost_micros: number }[]>`
      select stop_reason, cost_micros from usage_ledger where account_id = ${s.account.id}`;
    expect(rows).toEqual([{ stop_reason: "end_turn", cost_micros: 1_000 * 4 + 200 * 20 }]);
  });

  it("drops the reservation when the model can't start the turn", async () => {
    const upstream = new FakeUpstream();
    upstream.failWith = new Anthropic.APIConnectionError({ message: "down" });
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    expect((await turn(app, s.accessToken)).status).toBeGreaterThanOrEqual(500);
    const [n] = await db()<{ n: number }[]>`select count(*)::bigint as n from usage_ledger where account_id = ${s.account.id}`;
    expect(n!.n).toBe(0);
  });

  it("stops holding credits for a turn the server never finished", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    await db()`insert into usage_ledger (account_id, project_hash, thread_id, run_id, turn_index, task_type, model, cost_micros, stop_reason, created_at)
      select ${s.account.id}, 'p', 't', 'r', 0, 'change', 'm', 999999999, 'in_flight', now() - make_interval(mins => n)
      from generate_series(16, 18) as n`;
    expect((await turn(app, s.accessToken)).status).toBe(200);
  });
});

describe("per-account limits", () => {
  it("allows concurrentRuns turns in flight at once and answers 429 for more", async () => {
    const { upstream, release } = gatedUpstream(textReply("x", { input: 100, output: 10 }));
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const responses = await Promise.all(Array.from({ length: 5 }, () => turn(app, s.accessToken)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429]);
    const limited = responses.find((r) => r.status === 429)!;
    expect(await errorOf(limited)).toMatchObject({ code: "rate_limited", details: { reason: "too_many_in_flight" } });
    release();
    await Promise.all(responses.filter((r) => r.status === 200).map(readSse));
    expect((await turn(app, s.accessToken)).status).toBe(200);
  });

  it("answers 429 past turnsPerMinute", async () => {
    const { app } = makeApp({ config: withLimits({ turnsPerMinute: 3 }) });
    const s = await signIn(app);
    for (let i = 0; i < 3; i++) await readSse(await turn(app, s.accessToken));
    const res = await turn(app, s.accessToken);
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toMatchObject({ code: "rate_limited", details: { reason: "too_many_per_minute" } });
  });
});

describe("run caps", () => {
  it("count turns in flight, so turns sent at once can't pass the turn cap", async () => {
    const { upstream, release } = gatedUpstream(textReply("x", { input: 100, output: 10 }));
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const runId = "run-concurrent";
    await db()`insert into usage_ledger (account_id, project_hash, thread_id, run_id, turn_index, task_type, model, stop_reason)
      select ${s.account.id}, 'p', 't', ${runId}, n, 'change', 'm', 'end_turn' from generate_series(0, 6) as n`;
    const responses = await Promise.all([7, 8, 9].map((i) => turn(app, s.accessToken, turnBody({ runId, turnIndex: i }))));
    release();
    const events = await Promise.all(responses.map(readSse));
    const capped = events.filter((e) => e[0]?.event === "keel.error" && e[0].data.code === "run_limit_reached");
    expect(capped).toHaveLength(2);
    const [n] = await db()<{ n: number }[]>`select count(*)::bigint as n from usage_ledger where run_id = ${runId}`;
    expect(n!.n).toBe(8);
  });

  it("don't count turns that failed before a reply", async () => {
    const upstream = new FakeUpstream();
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const runId = "run-failures";
    const start = textReply("x", { input: 100, output: 1 }).slice(0, 1);
    upstream.stream = async () =>
      (async function* () {
        for (const e of start) yield e;
        throw new Anthropic.APIConnectionError({ message: "reset" });
      })();
    for (let i = 0; i < 8; i++) await readSse(await turn(app, s.accessToken, turnBody({ runId, turnIndex: i })));

    upstream.stream = FakeUpstream.prototype.stream.bind(upstream);
    const events = await readSse(await turn(app, s.accessToken, turnBody({ runId, turnIndex: 8 })));
    expect(events.at(0)!.event).toBe("message_start");
    expect(events.find((e) => e.event === "keel.usage")!.data).toMatchObject({ runTurnsLeft: 7 });
  });
});
