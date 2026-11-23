import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Secret for signing 15-minute access tokens. At least 32 random bytes. */
  ACCESS_TOKEN_SECRET: z.string().min(32),
  /** Salt for hashing the app's opaque project ids before they are stored. */
  PROJECT_HASH_SALT: z.string().min(16),
  /** Audience the Apple identity token must carry: the Mac app's bundle id. */
  APPLE_CLIENT_ID: z.string().min(1),
  /** Public https origin of this service (the Railway domain), for Stripe's return pages. */
  PUBLIC_BASE_URL: z.url().default("http://localhost:8080"),
  /** Resend sends sign-in codes. Without a key, development prints codes to the log. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Keel <signin@keel.app>"),
  /** WorkOS, for Single Sign-On. SSO routes answer 503 until both are set. */
  WORKOS_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WORKOS_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** The app's URL scheme callback for the end of an SSO sign-in. */
  SSO_APP_CALLBACK: z.string().default("keel://auth/sso"),
  /** Stripe. Billing routes answer 503 until the key, webhook secret and a price are set. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_MONTH: z.string().optional(),
  STRIPE_PRICE_YEAR: z.string().optional(),
  /** One-time price of a 1,000-credit pack ($10). Packs answer 503 until it is set. */
  STRIPE_PRICE_PACK: z.string().optional(),
  STRIPE_AUTOMATIC_TAX: z.enum(["true", "false"]).default("false"),
  /**
   * Self-hosted model: vLLM's Anthropic-compatible endpoint (e.g. a Vast.ai
   * instance's vLLM API address, without /v1). Unset, every turn goes to Claude.
   * Must be https:// in production.
   */
  SELF_HOSTED_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  /** Sent as "Authorization: Bearer": vLLM's --api-key, or the Vast.ai portal token. */
  SELF_HOSTED_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /**
   * Project files. With S3_BUCKET set they go to that S3-compatible bucket
   * (Railway Buckets, Cloudflare R2, AWS S3); without it, to Postgres.
   */
  S3_BUCKET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  S3_ENDPOINT: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** Blob bytes each account may keep (default 5 GB) and the largest single file (default 512 MB). */
  STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3),
  BLOB_MAX_BYTES: z.coerce.number().int().positive().default(512 * 1024 ** 2),
  /** App Attest is phase 2. "off" accepts requests without an assertion. */
  APP_ATTEST_MODE: z.enum(["off", "enforce"]).default("off"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.SELF_HOSTED_BASE_URL && !parsed.data.SELF_HOSTED_BASE_URL.startsWith("https://")) {
    // Prompts, replies and the bearer token would cross the internet in the clear.
    throw new Error("Invalid environment: SELF_HOSTED_BASE_URL must be https:// in production (use a TLS tunnel or the host's HTTPS endpoint)");
  }
  const s3 = parsed.data;
  if (s3.S3_BUCKET && (!s3.S3_ACCESS_KEY_ID || !s3.S3_SECRET_ACCESS_KEY)) {
    throw new Error("Invalid environment: S3_BUCKET needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  }
  if (parsed.data.NODE_ENV === "production" && !s3.S3_BUCKET) {
    console.warn(JSON.stringify({ level: "warn", msg: "S3_BUCKET is not set: project files are stored in Postgres" }));
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.APP_ATTEST_MODE === "off") {
    console.warn(JSON.stringify({ level: "warn", msg: "APP_ATTEST_MODE is off in production" }));
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.RESEND_API_KEY) {
    console.warn(JSON.stringify({ level: "warn", msg: "RESEND_API_KEY is not set: email sign-in answers 503" }));
  }
  return parsed.data;
}
