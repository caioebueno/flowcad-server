import type { Sql } from "./db/index.js";
import type { AppleIdentityVerifier } from "./auth/apple.js";
import type { AttestationVerifier } from "./auth/attest.js";
import type { AccessTokens } from "./auth/tokens.js";
import type { ConfigSource } from "./config/store.js";
import type { Upstream } from "./proxy/upstream.js";
import type { PlanProvider } from "./billing/plans.js";
import type { EmailCodes } from "./auth/emailCodes.js";
import type { Mailer } from "./auth/mailer.js";
import type { BillingGateway } from "./billing/stripe.js";
import type { SearchProvider } from "./search/provider.js";

import type { BlobStore } from "./storage/blobStore.js";

import type { SsoProvider } from "./auth/sso.js";


/** Everything the routes need, injected so tests can swap Apple, Anthropic and billing. */
export interface Deps {
  sql: Sql;
  apple: AppleIdentityVerifier;
  attestation: AttestationVerifier;
  accessTokens: AccessTokens;
  config: ConfigSource;
  upstream: Upstream;
  /** The self-hosted model; null or absent when SELF_HOSTED_BASE_URL isn't set. */
  selfHosted?: Upstream | null;
  plans: PlanProvider;
  emailCodes: EmailCodes;
  mailer: Mailer;
  /** null when Stripe isn't configured: billing routes answer 503. */
  billing: BillingGateway | null;
  /** null when WorkOS isn't configured: SSO routes answer 503. */
  sso: SsoProvider | null;
  /** Where the SSO callback hands the one-time code back to the app (a keel:// URL). */
  ssoAppCallback: string;
  /** Public https origin of this service, for Stripe's return pages and the SSO callback. */
  publicBaseUrl: string;
  projectHashSalt: string;
  /** Web search for search_step_models; null or absent when no search key is set (503 search_unavailable). */
  search?: SearchProvider | null;
  /** Bytes of synced project files (models, photos, datasheets, exports). */
  blobs: BlobStore;
  storage: StorageLimits;
}

export interface StorageLimits {
  /** Total blob bytes one account may keep. */
  quotaBytes: number;
  /** Largest single blob. */
  maxBlobBytes: number;
}

export interface AuthContext {
  accountId: string;
  deviceId: string;
}

export type AppEnv = { Variables: { auth: AuthContext; requestId: string } };
