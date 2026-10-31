import type { Sql } from "./db/index.js";
import type { AppleIdentityVerifier } from "./auth/apple.js";
import type { AttestationVerifier } from "./auth/attest.js";
import type { AccessTokens } from "./auth/tokens.js";
import type { ConfigSource } from "./config/store.js";
import type { Upstream } from "./proxy/upstream.js";
import type { PlanProvider } from "./billing/plans.js";

/** Everything the routes need, injected so tests can swap Apple, Anthropic and billing. */
export interface Deps {
  sql: Sql;
  apple: AppleIdentityVerifier;
  attestation: AttestationVerifier;
  accessTokens: AccessTokens;
  config: ConfigSource;
  upstream: Upstream;
  plans: PlanProvider;
  projectHashSalt: string;
}

export interface AuthContext {
  accountId: string;
  deviceId: string;
}

export type AppEnv = { Variables: { auth: AuthContext; requestId: string } };
