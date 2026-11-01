import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { connect, type Sql } from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { appleVerifier, APPLE_ISSUER } from "../src/auth/apple.js";
import { attestationDisabled } from "../src/auth/attest.js";
import { AccessTokens } from "../src/auth/tokens.js";
import { staticConfig } from "../src/config/store.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { ConfigDoc } from "../src/config/schema.js";
import { ConfigPlanProvider } from "../src/billing/plans.js";
import type { StreamEvent, Upstream, UpstreamParams } from "../src/proxy/upstream.js";
import { EmailCodes } from "../src/auth/emailCodes.js";
import type { Mailer } from "../src/auth/mailer.js";
import type { BillingGateway, CheckoutInput, PackCheckoutInput } from "../src/billing/stripe.js";
import Stripe from "stripe";

export const CLIENT_ID = "app.keel.mac";
let sql: Sql | null = null;
export const db = () => (sql ??= connect(process.env.TEST_DATABASE_URL!, { max: 4 }));

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

export async function appleToken(
  sub: string,
  opts: { aud?: string; nonce?: string; email?: string; emailVerified?: boolean } = {},
) {
  return new SignJWT({
    ...(opts.email ? { email: opts.email, email_verified: opts.emailVerified ?? true } : {}),
    ...(opts.nonce ? { nonce: createHash("sha256").update(opts.nonce).digest("hex") } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(APPLE_ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
}

/** Records every request and replays scripted stream events. */
export class FakeUpstream implements Upstream {
  calls: UpstreamParams[] = [];
  events: StreamEvent[] = textReply("Hello", { input: 1000, output: 200 });
  failWith: Error | null = null;

  async stream(params: UpstreamParams) {
    this.calls.push(params);
    if (this.failWith) throw this.failWith;
    const events = this.events;
    return (async function* () {
      for (const e of events) yield e;
    })();
  }
  async prewarm(params: UpstreamParams) {
    this.calls.push(params);
    return { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0 } as never;
  }
}

export function textReply(
  text: string,
  u: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
  extra: { iterations?: unknown[]; stopReason?: string } = {},
): StreamEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: u.input,
          output_tokens: 1,
          cache_creation_input_tokens: u.cacheWrite ?? 0,
          cache_read_input_tokens: u.cacheRead ?? 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: extra.stopReason ?? "end_turn" },
      usage: { output_tokens: u.output, iterations: extra.iterations ?? null },
    },
    { type: "message_stop" },
  ] as unknown as StreamEvent[];
}

/** Keeps the last code mailed to each address. */
export class FakeMailer implements Mailer {
  codes = new Map<string, string>();
  fail = false;
  async sendSignInCode({ to, code }: { to: string; code: string }) {
    if (this.fail) throw new Error("mail down");
    this.codes.set(to, code);
  }
}

export const WEBHOOK_SECRET = "whsec_test_secret";
const stripeForSigning = new Stripe("sk_test_dummy");

/** Stripe stand-in: records calls, serves subscriptions from a map, verifies webhooks with the real SDK. */
export class FakeBilling implements BillingGateway {
  customers: { accountId: string; email: string | null }[] = [];
  checkouts: CheckoutInput[] = [];
  packCheckouts: PackCheckoutInput[] = [];
  endedTrials: string[] = [];
  subscriptions = new Map<string, Stripe.Subscription>();
  /** null turns packs off, as when STRIPE_PRICE_PACK isn't set. */
  packPriceIdValue: string | null = "price_pack";
  packPriceId() {
    return this.packPriceIdValue;
  }
  async packPrice() {
    return this.packPriceIdValue ? { unitAmount: 1000, currency: "usd" } : null;
  }
  async createPackCheckout(input: PackCheckoutInput) {
    this.packCheckouts.push(input);
    return "https://checkout.stripe.com/c/pay/pack";
  }
  /** Replaces the subscription with what Stripe returns after trial_end: "now"; tests set `afterTrial`. */
  afterTrial: ((sub: Stripe.Subscription) => Stripe.Subscription) | null = null;
  async endTrial(id: string) {
    this.endedTrials.push(id);
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`no subscription ${id}`);
    const next = this.afterTrial ? this.afterTrial(sub) : ({ ...sub, status: "active", trial_end: null } as Stripe.Subscription);
    this.subscriptions.set(id, next);
    return next;
  }
  priceFor(interval: "month" | "year") {
    return interval === "month" ? "price_month" : "price_year";
  }
  async prices() {
    return [
      { interval: "month" as const, priceId: "price_month", unitAmount: 2000, currency: "usd" },
      { interval: "year" as const, priceId: "price_year", unitAmount: 19200, currency: "usd" },
    ];
  }
  async createCustomer(input: { accountId: string; email: string | null }) {
    this.customers.push(input);
    return `cus_${this.customers.length}_${input.accountId.slice(0, 8)}`;
  }
  async createCheckout(input: CheckoutInput) {
    this.checkouts.push(input);
    return "https://checkout.stripe.com/c/pay/test";
  }
  async createPortal() {
    return "https://billing.stripe.com/p/session/test";
  }
  async retrieveSubscription(id: string) {
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`no subscription ${id}`);
    return sub;
  }
  verifyWebhook(raw: string, signature: string) {
    return stripeForSigning.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET);
  }
}

export function signedWebhook(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const header = stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, header };
}

export function makeApp(
  opts: { config?: ConfigDoc; upstream?: FakeUpstream; mailer?: FakeMailer; billing?: FakeBilling | null } = {},
) {
  const upstream = opts.upstream ?? new FakeUpstream();
  const mailer = opts.mailer ?? new FakeMailer();
  const billing = opts.billing === undefined ? new FakeBilling() : opts.billing;
  const app = createApp({
    sql: db(),
    apple: appleVerifier(CLIENT_ID, jwks),
    attestation: attestationDisabled,
    accessTokens: new AccessTokens("test-secret-test-secret-test-secret-1234"),
    config: staticConfig(opts.config ?? DEFAULT_CONFIG),
    upstream,
    plans: new ConfigPlanProvider(db()),
    projectHashSalt: "test-salt-test-salt",
    emailCodes: new EmailCodes(db(), "test-code-secret"),
    mailer,
    billing,
    publicBaseUrl: "https://api.keel.test",
  });
  return { app, upstream, mailer, billing };
}

export type TestApp = ReturnType<typeof makeApp>["app"];

/**
 * Signs in with Apple. Accounts start on Free; tests that use the AI get the
 * hand-assigned "beta" plan unless they ask for another.
 */
export async function signIn(app: TestApp, sub = `apple-${randomUUID()}`, deviceId = randomUUID(), plan: string | null = "beta") {
  const res = await app.request("/v1/auth/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityToken: await appleToken(sub), device: { id: deviceId, name: "Mac", appVersion: "1.0.0" } }),
  });
  if (res.status !== 200) throw new Error(`sign in failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accessToken: string; refreshToken: string; account: { id: string } };
  if (plan) await db()`update accounts set plan = ${plan} where id = ${body.account.id}`;
  return { ...body, deviceId, sub };
}

export const authed = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
});

export function turnBody(overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  return {
    taskType: "change",
    runId: randomUUID(),
    turnIndex: 0,
    projectId: "proj-1",
    threadId: "thread-1",
    request: {
      system: [{ type: "text", text: "You are Keel.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "add_feature", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "Add a 5mm fillet" }],
      ...request,
    },
    ...overrides,
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      return { event, data: JSON.parse(data) };
    });
}
