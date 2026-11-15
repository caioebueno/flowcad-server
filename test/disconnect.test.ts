import { describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { authed, db, FakeUpstream, makeApp, signIn, textReply, turnBody } from "./helpers.js";

describe("client disconnect", () => {
  it("cancels the upstream request and still records usage", async () => {
    const upstream = new FakeUpstream();
    let aborted = false;
    upstream.stream = async (_p, signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      const first = textReply("x", { input: 700, output: 1 }).slice(0, 3);
      return (async function* () {
        for (const e of first) yield e;
        // Then hang like a long generation until cancelled.
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })();
    };
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;

    const body = turnBody();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/agent/turn`, {
      method: "POST",
      headers: authed(s.accessToken),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();

    let row;
    for (let i = 0; i < 50 && !row; i++) {
      await new Promise((r) => setTimeout(r, 50));
      [row] = await db()`select stop_reason, input_tokens from usage_ledger where run_id = ${body.runId}`;
    }
    server.close();
    expect(aborted).toBe(true);
    expect(row).toMatchObject({ stop_reason: "client_disconnected", input_tokens: 700 });
  });

  it("charges the output streamed before the disconnect, not one token", async () => {
    const upstream = new FakeUpstream();
    const text = "x".repeat(3_000);
    upstream.stream = async (_p, signal) => {
      const reply = textReply(text, { input: 500, output: 30_000 }).slice(0, 4); // up to content_block_stop
      return (async function* () {
        for (const e of reply) yield e;
        // The final message_delta, with the real output count, never comes.
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      })();
    };
    const { app } = makeApp({ upstream });
    const s = await signIn(app);
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;

    const body = turnBody();
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/agent/turn`, {
      method: "POST",
      headers: authed(s.accessToken),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("content_block_stop")) seen += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();

    let row: { stop_reason: string; output_tokens: number; cost_micros: number } | undefined;
    for (let i = 0; i < 50 && row?.stop_reason !== "client_disconnected"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      [row] = await db()<{ stop_reason: string; output_tokens: number; cost_micros: number }[]>`
        select stop_reason, output_tokens, cost_micros from usage_ledger where run_id = ${body.runId}`;
    }
    server.close();
    expect(row!.stop_reason).toBe("client_disconnected");
    // 3,000 characters at 3 a token: 1,000 output tokens, not the 1 from message_start.
    expect(row!.output_tokens).toBe(1_000);
    expect(row!.cost_micros).toBe(500 * 4 + 1_000 * 20);
  });
});
