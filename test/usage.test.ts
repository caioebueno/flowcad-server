import { describe, expect, it } from "vitest";
import { authed, makeApp, readSse, signIn, textReply, turnBody } from "./helpers.js";

describe("GET /usage and /account", () => {
  it("groups use by task type and project, as percent of the allowance", async () => {
    const { app, upstream } = makeApp();
    upstream.events = textReply("x", { input: 0, output: 25_000 }); // $0.50 = 1% of $50
    const s = await signIn(app);
    const t = (o: Record<string, unknown>) =>
      app.request("/v1/agent/turn", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(turnBody(o)) }).then(readSse);
    await t({ taskType: "change", projectId: "A" });
    await t({ taskType: "change", projectId: "B" });
    await t({ taskType: "ask", projectId: "A" });

    const byTask = (await (await app.request("/v1/usage?groupBy=task_type", { headers: authed(s.accessToken) })).json()) as {
      rows: { key: string; turns: number; allowancePercent: number }[];
    };
    expect(byTask.rows).toEqual([
      expect.objectContaining({ key: "ask", turns: 1, allowancePercent: 1 }),
      expect.objectContaining({ key: "change", turns: 2, allowancePercent: 2 }),
    ]);
    expect(JSON.stringify(byTask)).not.toContain("cost");

    const byProject = (await (
      await app.request("/v1/usage?groupBy=project&projectIds=A,B", { headers: authed(s.accessToken) })
    ).json()) as { rows: { projectId: string; turns: number }[] };
    expect(Object.fromEntries(byProject.rows.map((r) => [r.projectId, r.turns]))).toEqual({ A: 2, B: 1 });

    const byDay = (await (await app.request("/v1/usage", { headers: authed(s.accessToken) })).json()) as { rows: unknown[] };
    expect(byDay.rows).toHaveLength(1);

    const account = (await (await app.request("/v1/account", { headers: authed(s.accessToken) })).json()) as {
      plan: { id: string };
      allowance: { usedPercent: number; warning: boolean };
    };
    expect(account.plan.id).toBe("beta");
    expect(account.allowance).toMatchObject({ usedPercent: 3, warning: false });
  });

  it("keeps accounts apart", async () => {
    const { app } = makeApp();
    const a = await signIn(app);
    const b = await signIn(app);
    await app.request("/v1/agent/turn", { method: "POST", headers: authed(a.accessToken), body: JSON.stringify(turnBody()) }).then(readSse);
    const res = (await (await app.request("/v1/usage", { headers: authed(b.accessToken) })).json()) as { rows: unknown[] };
    expect(res.rows).toHaveLength(0);
  });
});
