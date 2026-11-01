import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { migrate } from "../src/db/index.js";
import { EXPECTED_MIGRATIONS } from "../src/app.js";
import { db, makeApp } from "./helpers.js";

describe("migrations", () => {
  it("are idempotent and safe to run from two instances at once", async () => {
    const results = await Promise.all([migrate(db()), migrate(db())]);
    expect(results.flat()).toEqual([]);
  });

  it("EXPECTED_MIGRATIONS matches the files on disk", async () => {
    const files = (await readdir(new URL("../migrations", import.meta.url))).filter((f) => f.endsWith(".sql"));
    expect(EXPECTED_MIGRATIONS).toBe(files.length);
  });

  it("health reports the schema", async () => {
    const res = await makeApp().app.request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, migrations: EXPECTED_MIGRATIONS });
  });
});
