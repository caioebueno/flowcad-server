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
  return parsed.data;
}
