import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const base = {
  DATABASE_URL: "postgres://x",
  ANTHROPIC_API_KEY: "sk-ant-x",
  ACCESS_TOKEN_SECRET: "s".repeat(32),
  PROJECT_HASH_SALT: "salt-salt-salt-salt",
  APPLE_CLIENT_ID: "app.keel.mac",
  RESEND_API_KEY: "re_x",
  APP_ATTEST_MODE: "enforce",
};

describe("self-hosted model address", () => {
  it("must be https in production, so prompts and the token aren't sent in the clear", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", SELF_HOSTED_BASE_URL: "http://203.0.113.5:41234" })).toThrow(/https/);
    expect(loadEnv({ ...base, NODE_ENV: "production", SELF_HOSTED_BASE_URL: "https://gpu.example.com" }).SELF_HOSTED_BASE_URL).toBe(
      "https://gpu.example.com",
    );
    expect(loadEnv({ ...base, NODE_ENV: "production" }).SELF_HOSTED_BASE_URL).toBeUndefined();
  });

  it("may be plain http outside production", () => {
    expect(loadEnv({ ...base, NODE_ENV: "development", SELF_HOSTED_BASE_URL: "http://127.0.0.1:8000" }).SELF_HOSTED_BASE_URL).toBe(
      "http://127.0.0.1:8000",
    );
  });
});
