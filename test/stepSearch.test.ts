import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { ConfigDocSchema, type ConfigDoc } from "../src/config/schema.js";
import type { SearchProvider, WebResult } from "../src/search/provider.js";
import { resetSearchState } from "../src/search/routes.js";
import { buildQuery, directFile, plain, siteFor, toStepModels } from "../src/search/stepModels.js";
import { authed, makeApp, signIn } from "./helpers.js";

const sites = DEFAULT_CONFIG.stepSearch!.sites;

class FakeSearch implements SearchProvider {
  queries: string[] = [];
  results: WebResult[] = [];
  failWith: Error | null = null;
  async search(query: string) {
    this.queries.push(query);
    if (this.failWith) throw this.failWith;
    return this.results;
  }
}

describe("step model results", () => {
  it("the default config is valid", () => {
    expect(ConfigDocSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("puts the allowed sites in the query and drops operators the app sent", () => {
    const q = buildQuery('608 bearing site:evil.example filetype:pdf "(x)"', sites);
    expect(q.startsWith("608 bearing x STEP model (site:github.com OR ")).toBe(true);
    expect(q).not.toContain("evil.example");
    expect(q).not.toContain("filetype");
  });

  it("turns GitHub and GitLab blobs into files Keel can fetch, and nothing else", () => {
    const at = (u: string) => directFile(new URL(u), siteFor(new URL(u), sites)!);
    expect(at("https://github.com/FreeCAD/FreeCAD-library/blob/master/Mechanical%20Parts/608.step")).toBe(
      "https://raw.githubusercontent.com/FreeCAD/FreeCAD-library/master/Mechanical%20Parts/608.step",
    );
    expect(at("https://gitlab.com/kicad/libraries/kicad-packages3D/-/blob/master/Connector.3dshapes/J.step")).toBe(
      "https://gitlab.com/kicad/libraries/kicad-packages3D/-/raw/master/Connector.3dshapes/J.step",
    );
    expect(at("https://github.com/FreeCAD/FreeCAD-library")).toBeNull();
    expect(at("https://www.traceparts.com/en/product/608.stp")).toBeNull();
    expect(siteFor(new URL("https://github.com.evil.example/a.step"), sites)).toBeNull();
    expect(siteFor(new URL("https://www.grabcad.com/library/x"), sites)?.name).toBe("GrabCAD");
  });

  it("keeps allowed https results once each, files first, as plain text", () => {
    const out = toStepModels(
      [
        { title: "608 <strong>bearing</strong> &amp; seal", url: "https://www.traceparts.com/p/608", description: "Deep groove" },
        { title: "Evil", url: "https://evil.example/608.step" },
        { title: "Plain http", url: "http://github.com/a/b/blob/main/x.step" },
        { title: "608.step", url: "https://github.com/a/b/blob/main/608.step#L1" },
        { title: "608.step again", url: "https://github.com/a/b/blob/main/608.step" },
      ],
      sites,
      5,
    );
    expect(out.map((r) => r.title)).toEqual(["608.step", "608 bearing & seal"]);
    expect(out[0]!.fileUrl).toBe("https://raw.githubusercontent.com/a/b/main/608.step");
    expect(out[1]).toMatchObject({ fileUrl: null, source: "TraceParts", snippet: "Deep groove" });
    expect(plain("<b>a</b>&nbsp;&quot;b&quot;", 10)).toBe('a "b"');
  });
});

describe("POST /search/step-models", () => {
  beforeEach(() => resetSearchState());
  const post = (app: ReturnType<typeof makeApp>["app"], token: string, body: unknown) =>
    app.request("/v1/search/step-models", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

  it("answers with the allowed results", async () => {
    const search = new FakeSearch();
    search.results = [
      { title: "NEMA 17", url: "https://grabcad.com/library/nema-17" },
      { title: "Elsewhere", url: "https://example.com/nema17.step" },
    ];
    const { app } = makeApp({ search });
    const s = await signIn(app);
    const res = await post(app, s.accessToken, { query: "NEMA 17 stepper", limit: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { title: string; source: string }[] };
    expect(body.results).toEqual([expect.objectContaining({ title: "NEMA 17", source: "GrabCAD", fileUrl: null })]);
    expect(search.queries[0]).toContain("NEMA 17 stepper STEP model (site:github.com");

    // The same search again comes from the cache.
    await post(app, s.accessToken, { query: "nema 17 stepper", limit: 3 });
    expect(search.queries).toHaveLength(1);
  });

  it("is off without a provider or when config turns it off, and Pro only", async () => {
    const off = makeApp({ search: null });
    const a = await signIn(off.app);
    expect((await post(off.app, a.accessToken, { query: "608 bearing" })).status).toBe(503);

    const config: ConfigDoc = { ...DEFAULT_CONFIG, stepSearch: { ...DEFAULT_CONFIG.stepSearch!, enabled: false } };
    const disabled = makeApp({ config, search: new FakeSearch() });
    const b = await signIn(disabled.app);
    const res = await post(disabled.app, b.accessToken, { query: "608 bearing" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("search_unavailable");

    const { app } = makeApp({ search: new FakeSearch() });
    const free = await signIn(app, undefined, undefined, null);
    expect((await post(app, free.accessToken, { query: "608 bearing" })).status).toBe(403);
  });

  it("checks the body, limits searches an hour and reports a provider failure", async () => {
    const search = new FakeSearch();
    const config: ConfigDoc = { ...DEFAULT_CONFIG, stepSearch: { ...DEFAULT_CONFIG.stepSearch!, searchesPerHour: 2 } };
    const { app } = makeApp({ config, search });
    const s = await signIn(app);
    expect((await post(app, s.accessToken, { query: "x" })).status).toBe(400);
    expect((await post(app, s.accessToken, { query: "608 bearing", limit: 50 })).status).toBe(400);
    expect((await post(app, s.accessToken, { query: "608 bearing", url: "https://a" })).status).toBe(400);

    search.failWith = new Error("brave_500");
    expect((await post(app, s.accessToken, { query: "first part" })).status).toBe(502);
    search.failWith = null;
    expect((await post(app, s.accessToken, { query: "second part" })).status).toBe(200);
    const limited = await post(app, s.accessToken, { query: "third part" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
