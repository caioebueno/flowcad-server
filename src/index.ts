import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { connect } from "./db/index.js";
import { createApp } from "./app.js";
import { appleVerifier } from "./auth/apple.js";
import { attestationDisabled, attestationNotImplemented } from "./auth/attest.js";
import { AccessTokens } from "./auth/tokens.js";
import { ConfigStore } from "./config/store.js";
import { AnthropicUpstream } from "./proxy/upstream.js";
import { ConfigPlanProvider } from "./billing/plans.js";
import { log } from "./logger.js";

const env = loadEnv();
const sql = connect(env.DATABASE_URL);

const app = createApp({
  sql,
  apple: appleVerifier(env.APPLE_CLIENT_ID),
  attestation: env.APP_ATTEST_MODE === "enforce" ? attestationNotImplemented : attestationDisabled,
  accessTokens: new AccessTokens(env.ACCESS_TOKEN_SECRET),
  config: new ConfigStore(sql),
  upstream: new AnthropicUpstream(env.ANTHROPIC_API_KEY),
  plans: new ConfigPlanProvider(sql),
  projectHashSalt: env.PROJECT_HASH_SALT,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) =>
  log.info("listening", { port: info.port }),
);

// Railway sends SIGTERM when a deploy replaces this instance. Stop taking new
// connections and give streams in flight time to finish (railway.json sets
// drainingSeconds to 300).
let closing = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    log.info("shutting_down", { signal: sig });
    server.close(async () => {
      await sql.end({ timeout: 5 });
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 290_000).unref();
  });
}
