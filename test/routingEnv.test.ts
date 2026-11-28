import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { staticConfig, withRoutingTiers } from "../src/config/store.js";
import { loadEnv } from "../src/env.js";

const base = {
  DATABASE_URL: "postgres://x",
  ANTHROPIC_API_KEY: "sk-ant-x",
  ACCESS_TOKEN_SECRET: "s".repeat(32),
  PROJECT_HASH_SALT: "salt-salt-salt-salt",
  APPLE_CLIENT_ID: "app.keel.mac",
};

describe("ROUTING_TIERS", () => {
  it("is read as true, false or unset", () => {
    expect(loadEnv({ ...base, ROUTING_TIERS: "true" }).ROUTING_TIERS).toBe("true");
    expect(loadEnv({ ...base, ROUTING_TIERS: "false" }).ROUTING_TIERS).toBe("false");
    expect(loadEnv({ ...base, ROUTING_TIERS: "" }).ROUTING_TIERS).toBeUndefined();
    expect(loadEnv(base).ROUTING_TIERS).toBeUndefined();
    expect(() => loadEnv({ ...base, ROUTING_TIERS: "yes" })).toThrow(/ROUTING_TIERS/);
  });

  it("forces routing.tiers on the published config and keeps the rest", async () => {
    const source = staticConfig(DEFAULT_CONFIG, 3);
    const on = await withRoutingTiers(source, true).current();
    expect(on.doc.routing?.tiers).toBe(true);
    expect(on.version).toBe(3);
    expect(on.doc.taskProfiles).toEqual(DEFAULT_CONFIG.taskProfiles);
    expect({ ...on.doc.routing, tiers: false }).toEqual(DEFAULT_CONFIG.routing);
    expect(on.etag).not.toBe((await source.current()).etag);
  });

  it("turns it off too, and leaves the config alone when unset", async () => {
    const published = staticConfig({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing!, tiers: true } }, 4);
    expect((await withRoutingTiers(published, false).current()).doc.routing?.tiers).toBe(false);
    expect(withRoutingTiers(published, undefined)).toBe(published);
  });

  it("gives a config published without routing the bundled routing", async () => {
    const { routing: _r, ...older } = DEFAULT_CONFIG;
    const on = await withRoutingTiers(staticConfig(older, 2), true).current();
    expect(on.doc.routing).toEqual({ ...DEFAULT_CONFIG.routing, tiers: true });
  });
});
