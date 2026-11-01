import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { authed, db, FakeBilling, makeApp, readSse, signedWebhook, signIn, textReply, turnBody } from "./helpers.js";

type App = ReturnType<typeof makeApp>["app"];
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

function subscription(id: string, customer: string, accountId: string, status: string, opts: { start: number; end: number; trialEnd?: number | null; interval?: "month" | "year" }) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    metadata: { account_id: accountId },
    cancel_at_period_end: false,
    trial_end: opts.trialEnd ?? null,
    items: {
      data: [
        {
          price: { id: `price_${opts.interval ?? "year"}`, recurring: { interval: opts.interval ?? "year" } },
          current_period_start: opts.start,
          current_period_end: opts.end,
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

let seq = 0;
const event = (type: string, object: unknown) => ({ id: `evt_cr_${Date.now()}_${seq++}`, object: "event", type, data: { object } });

async function deliver(app: App, ev: Record<string, unknown>) {
  const { payload, header } = signedWebhook(ev);
  return app.request("/v1/billing/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

interface Credits {
  monthlyUsed: number;
  monthlyLimit: number;
  extra: number;
  extraExpiresAt: string | null;
  resetsAt: string;
  isTrial: boolean;
  low: boolean;
  exhausted: boolean;
  left: number;
  canBuyPack: boolean;
}
const account = async (app: App, token: string) =>
  (await (await app.request("/v1/account", { headers: authed(token) })).json()) as {
    credits: Credits | null;
    entitlement: { tier: string; source: string | null; interval: string | null; expiresAt: string | null };
  };

const turn = (app: App, token: string, body = turnBody()) =>
  app.request("/v1/agent/turn", { method: "POST", headers: authed(token), body: JSON.stringify(body) });

const post = (app: App, token: string, path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: authed(token), body: JSON.stringify(body) });

/** A Free account with a Stripe customer, put on a subscription through the webhook. */
async function subscribed(status: "trialing" | "active", billing = new FakeBilling()) {
  const made = makeApp({ billing });
  const s = await signIn(made.app, undefined, undefined, null);
  const customer = `cus_cr_${s.account.id.slice(0, 8)}`;
  await db()`update accounts set stripe_customer_id = ${customer} where id = ${s.account.id}`;
  const subId = `sub_cr_${s.account.id.slice(0, 8)}`;
  const start = now() - DAY;
  const end = status === "trialing" ? start + 15 * DAY : start + 365 * DAY;
  billing.subscriptions.set(
    subId,
    subscription(subId, customer, s.account.id, status, { start, end, trialEnd: status === "trialing" ? end : null }),
  );
  expect((await deliver(made.app, event("customer.subscription.created", { id: subId }))).status).toBe(200);
  return { ...made, s, customer, subId, start, end };
}

/** Grants one pack the way Stripe announces it after Checkout. */
const packPaid = (accountId: string, pi: string) =>
  event("checkout.session.completed", {
    id: `cs_${pi}`,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    payment_intent: pi,
    amount_total: 1000,
    currency: "usd",
    metadata: { account_id: accountId, kind: "credit_pack" },
  });

describe("credits on GET /account", () => {
  it("is null on Free", async () => {
    const { app } = makeApp();
    const s = await signIn(app, undefined, undefined, null);
    expect((await account(app, s.accessToken)).credits).toBeNull();
  });

  it("gives a trial 1,000 credits that reset when the trial ends", async () => {
    const { app, s, end } = await subscribed("trialing");
    const a = await account(app, s.accessToken);
    expect(a.entitlement).toMatchObject({ tier: "pro", source: "trial", interval: "year" });
    expect(a.credits).toMatchObject({ monthlyUsed: 0, monthlyLimit: 1000, extra: 0, isTrial: true, low: false, exhausted: false, canBuyPack: false });
    expect(Date.parse(a.credits!.resetsAt)).toBe(end * 1000);
  });

  it("gives Pro 2,000 credits a billing period, starting fresh each period", async () => {
    const { app, s, start, end } = await subscribed("active");
    // Use from the period before doesn't count.
    await db()`insert into allowances (account_id, period_start, limit_micros, used_micros)
      values (${s.account.id}, ${new Date((start - 30 * DAY) * 1000)}, 13333333, 13333333)`;
    const a = await account(app, s.accessToken);
    expect(a.entitlement.source).toBe("stripe");
    expect(a.credits).toMatchObject({ monthlyUsed: 0, monthlyLimit: 2000, isTrial: false, canBuyPack: true, left: 2000 });
    expect(Date.parse(a.credits!.resetsAt)).toBe(end * 1000);
  });
});

describe("POST /billing/trial/end", () => {
  it("ends the trial and starts a fresh period of Pro credits", async () => {
    const billing = new FakeBilling();
    const { app, s, subId, customer, upstream } = await subscribed("trialing", billing);
    upstream.events = textReply("x", { input: 0, output: 25_000 }); // 75 credits
    await readSse(await turn(app, s.accessToken));
    expect((await account(app, s.accessToken)).credits).toMatchObject({ monthlyUsed: 75, monthlyLimit: 1000 });

    const started = now();
    billing.afterTrial = () =>
      subscription(subId, customer, s.account.id, "active", { start: started, end: started + 365 * DAY, interval: "year" });
    const res = await post(app, s.accessToken, "/v1/billing/trial/end");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entitlement: { source: string }; credits: Credits };
    expect(billing.endedTrials).toEqual([subId]);
    expect(body.entitlement.source).toBe("stripe");
    expect(body.credits).toMatchObject({ monthlyUsed: 0, monthlyLimit: 2000, isTrial: false });

    expect((await post(app, s.accessToken, "/v1/billing/trial/end")).status).toBe(409);
  });

  it("answers 409 not_trialing without a trial", async () => {
    const { app } = makeApp();
    const s = await signIn(app);
    const res = await post(app, s.accessToken, "/v1/billing/trial/end");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_trialing");
  });
});

describe("credit packs", () => {
  it("lists the pack and the trial on /billing/plans", async () => {
    const { app } = makeApp();
    const s = await signIn(app, undefined, undefined, null);
    const body = (await (await app.request("/v1/billing/plans", { headers: authed(s.accessToken) })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      trialDays: 15,
      trialCredits: 1000,
      monthlyCredits: 2000,
      pack: { credits: 1000, amount: 1000, currency: "usd" },
    });
  });

  it("can't be bought on Free or during a trial", async () => {
    const { app } = makeApp();
    const free = await signIn(app, undefined, undefined, null);
    const res = await post(app, free.accessToken, "/v1/billing/packs/checkout");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("plan_required");

    const trial = await subscribed("trialing");
    const t = await post(trial.app, trial.s.accessToken, "/v1/billing/packs/checkout");
    expect(t.status).toBe(409);
    expect(((await t.json()) as { error: { code: string } }).error.code).toBe("packs_unavailable_during_trial");
  });

  it("opens a one-time checkout for Pro that returns to the app", async () => {
    const billing = new FakeBilling();
    const { app, s, customer } = await subscribed("active", billing);
    const res = await post(app, s.accessToken, "/v1/billing/packs/checkout", { context: "out_of_credits" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/pack" });
    expect(billing.packCheckouts[0]).toMatchObject({
      customerId: customer,
      priceId: "price_pack",
      accountId: s.account.id,
      context: "out_of_credits",
      successUrl: "https://api.keel.test/v1/billing/return/pack-success",
      cancelUrl: "https://api.keel.test/v1/billing/return/cancel",
    });
    expect(await (await app.request("/v1/billing/return/pack-success")).text()).toContain("keel://billing/pack-success");
  });

  it("answers 503 when no pack price is configured", async () => {
    const billing = new FakeBilling();
    billing.packPriceIdValue = null;
    const { app, s } = await subscribed("active", billing);
    expect((await post(app, s.accessToken, "/v1/billing/packs/checkout")).status).toBe(503);
    expect((await account(app, s.accessToken)).credits!.canBuyPack).toBe(false);
  });

  it("adds 1,000 credits once per payment, for 12 months", async () => {
    const { app, s } = await subscribed("active");
    expect((await deliver(app, packPaid(s.account.id, "pi_once"))).status).toBe(200);
    // Stripe also sends payment_intent.succeeded for the same payment.
    await deliver(
      app,
      event("payment_intent.succeeded", {
        id: "pi_once",
        object: "payment_intent",
        amount_received: 1000,
        currency: "usd",
        metadata: { account_id: s.account.id, kind: "credit_pack" },
      }),
    );
    const a = await account(app, s.accessToken);
    expect(a.credits).toMatchObject({ extra: 1000, left: 3000 });
    const months = (Date.parse(a.credits!.extraExpiresAt!) - Date.now()) / (30.4 * DAY * 1000);
    expect(Math.round(months)).toBe(12);
  });

  it("is used after the monthly credits, and a refund removes what's left", async () => {
    const config = (await import("../src/config/defaults.js")).DEFAULT_CONFIG;
    const tiny = { ...config, plans: { ...config.plans, pro: { ...config.plans.pro!, monthlyCredits: 100 } } };
    const billing = new FakeBilling();
    const made = makeApp({ billing, config: tiny });
    const s = await signIn(made.app, undefined, undefined, null);
    const customer = `cus_tiny_${s.account.id.slice(0, 8)}`;
    await db()`update accounts set stripe_customer_id = ${customer} where id = ${s.account.id}`;
    const subId = `sub_tiny_${s.account.id.slice(0, 8)}`;
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "active", { start: now() - DAY, end: now() + 29 * DAY }));
    await deliver(made.app, event("customer.subscription.created", { id: subId }));
    const app = made.app;

    made.upstream.events = textReply("x", { input: 0, output: 50_000 }); // $1.00 = 150 credits
    await readSse(await turn(app, s.accessToken)); // 150 of 100: runs past, allowed to finish
    let res = await turn(app, s.accessToken);
    expect(res.status).toBe(402);
    const err = (await res.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(err.error).toMatchObject({ code: "credits_exhausted", details: { isTrial: false, canBuyPack: true } });

    await deliver(app, packPaid(s.account.id, "pi_tiny"));
    let a = await account(app, s.accessToken);
    expect(a.credits).toMatchObject({ monthlyUsed: 100, monthlyLimit: 100, extra: 1000, exhausted: false, left: 1000 });

    // Monthly credits are gone, so this turn comes out of the pack.
    const events = await readSse(await turn(app, s.accessToken));
    expect(events.find((e) => e.event === "keel.usage")!.data).toMatchObject({ creditsCharged: 150, creditsLeft: 850 });
    a = await account(app, s.accessToken);
    expect(a.credits).toMatchObject({ extra: 850, left: 850 });
    const [row] = await db()<{ extra_micros: number }[]>`
      select extra_micros from usage_ledger where account_id = ${s.account.id} order by created_at desc limit 1`;
    expect(row!.extra_micros).toBe(1_000_000);

    await deliver(app, event("charge.refunded", { id: "ch_1", object: "charge", refunded: true, payment_intent: "pi_tiny" }));
    a = await account(app, s.accessToken);
    expect(a.credits).toMatchObject({ extra: 0, exhausted: true });
    res = await turn(app, s.accessToken);
    expect(res.status).toBe(402);
  });
});
