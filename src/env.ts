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
  /** Stripe. Billing routes answer 503 until the key, webhook secret and a price are set. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_MONTH: z.string().optional(),
  STRIPE_PRICE_YEAR: z.string().optional(),
  /** One-time price of a 1,000-credit pack ($10). Packs answer 503 until it is set. */
  STRIPE_PRICE_PACK: z.string().optional(),
  STRIPE_AUTOMATIC_TAX: z.enum(["true", "false"]).default("false"),
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
  if (parsed.data.NODE_ENV === "production" && parsed.data.APP_ATTEST_MODE === "off") {
    console.warn(JSON.stringify({ level: "warn", msg: "APP_ATTEST_MODE is off in production" }));
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.RESEND_API_KEY) {
    console.warn(JSON.stringify({ level: "warn", msg: "RESEND_API_KEY is not set: email sign-in answers 503" }));
  }
  return parsed.data;
}
