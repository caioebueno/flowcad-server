import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { authed, db, FakeBilling, makeApp, readSse, signedWebhook, signIn, turnBody } from "./helpers.js";

const now = () => Math.floor(Date.now() / 1000);

function subscription(id: string, customer: string, accountId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    metadata: { account_id: accountId },
    cancel_at_period_end: false,
    trial_end: null,
    items: { data: [{ price: { id: "price_month" }, current_period_end: now() + 30 * 86400 }] },
    ...extra,
  } as unknown as Stripe.Subscription;
}

let seq = 0;
const event = (type: string, object: unknown) => ({ id: `evt_${Date.now()}_${seq++}`, object: "event", type, data: { object } });

async function deliver(app: ReturnType<typeof makeApp>["app"], ev: Record<string, unknown>) {
  const { payload, header } = signedWebhook(ev);
  return app.request("/v1/billing/stripe/webhook", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
}

const account = async (app: ReturnType<typeof makeApp>["app"], token: string) =>
  (await (await app.request("/v1/account", { headers: authed(token) })).json()) as {
    plan: { id: string; tier: string };
    entitlement: { tier: string; source: string | null; expiresAt: string | null; trialEligible: boolean; paymentFailed: boolean };
  };

describe("Free accounts", () => {
  it("get 403 plan_required from the agent, before the allowance check", async () => {
    const { app } = makeApp();
    const s = await signIn(app, undefined, undefined, null);
    const res = await app.request("/v1/agent/turn", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(turnBody()) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("plan_required");
    const a = await account(app, s.accessToken);
    expect(a.entitlement).toMatchObject({ tier: "free", source: null, trialEligible: true });
  });

  it("hand-assigned plans count as internal Pro", async () => {
    const { app } = makeApp();
    const s = await signIn(app, undefined, undefined, "internal");
    expect((await account(app, s.accessToken)).entitlement).toMatchObject({ tier: "pro", source: "internal" });
  });
});

describe("GET /billing/plans", () => {
  it("lists Pro prices and trial eligibility", async () => {
    const { app } = makeApp();
    const s = await signIn(app, undefined, undefined, null);
    const body = (await (await app.request("/v1/billing/plans", { headers: authed(s.accessToken) })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ trialDays: 14, trialEligible: true, billingAvailable: true });
    expect(JSON.stringify(body.plans)).toContain('"amount":2000');
  });
});

describe("checkout", () => {
  it("creates a customer once and a checkout with the trial", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const s = await signIn(app, undefined, undefined, null);
    const post = (body: unknown) =>
      app.request("/v1/billing/checkout", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(body) });
    const res = await post({ interval: "year", context: "selection_hud" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/test" });
    expect(billing.checkouts[0]).toMatchObject({
      priceId: "price_year",
      trialDays: 14,
      accountId: s.account.id,
      context: "selection_hud",
      successUrl: "https://api.keel.test/v1/billing/return/success",
      cancelUrl: "https://api.keel.test/v1/billing/return/cancel",
    });
    await post({ interval: "month" });
    expect(billing.customers).toHaveLength(1);
  });

  it("gives no second trial", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const s = await signIn(app, undefined, undefined, null);
    await db()`update accounts set trial_used_at = now() where id = ${s.account.id}`;
    await app.request("/v1/billing/checkout", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify({ interval: "month" }) });
    expect(billing.checkouts[0]!.trialDays).toBeNull();
  });

  it("returns 503 when Stripe isn't configured", async () => {
    const { app } = makeApp({ billing: null });
    const s = await signIn(app, undefined, undefined, null);
    const res = await app.request("/v1/billing/checkout", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify({ interval: "month" }) });
    expect(res.status).toBe(503);
  });

  it("serves return pages that hand back to the app", async () => {
    const { app } = makeApp();
    const page = await (await app.request("/v1/billing/return/success")).text();
    expect(page).toContain("keel://billing/success");
    expect(await (await app.request("/v1/billing/return/cancel")).text()).toContain("keel://billing/cancel");
  });
});

describe("Stripe webhook", () => {
  it("rejects a bad signature", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/billing/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=bad" },
      body: JSON.stringify(event("customer.subscription.created", {})),
    });
    expect(res.status).toBe(400);
  });

  it("moves an account through trial, paid, payment failed and cancelled", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const s = await signIn(app, undefined, undefined, null);
    const customer = `cus_${s.account.id.slice(0, 8)}`;
    await db()`update accounts set stripe_customer_id = ${customer} where id = ${s.account.id}`;
    const subId = `sub_${s.account.id.slice(0, 8)}`;

    // Trial starts.
    const trialEnd = now() + 14 * 86400;
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "trialing", { trial_end: trialEnd }));
    expect((await deliver(app, event("customer.subscription.created", { id: subId }))).status).toBe(200);
    let a = await account(app, s.accessToken);
    expect(a.plan.id).toBe("pro");
    expect(a.entitlement).toMatchObject({ tier: "pro", source: "trial", trialEligible: false });
    expect(Date.parse(a.entitlement.expiresAt!)).toBe(trialEnd * 1000);

    // The agent now works.
    const turn = await app.request("/v1/agent/turn", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify(turnBody()) });
    expect(turn.status).toBe(200);
    await readSse(turn);

    // Trial converts.
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "active"));
    await deliver(app, event("customer.subscription.updated", { id: subId }));
    expect((await account(app, s.accessToken)).entitlement.source).toBe("stripe");

    // Payment fails: Pro stays on while Stripe retries.
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "past_due"));
    await deliver(app, event("invoice.payment_failed", { id: "in_1", parent: { subscription_details: { subscription: subId } } }));
    a = await account(app, s.accessToken);
    expect(a.entitlement).toMatchObject({ tier: "pro", paymentFailed: true });

    // Cancelled: back to Free.
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "canceled"));
    await deliver(app, event("customer.subscription.deleted", { id: subId }));
    a = await account(app, s.accessToken);
    expect(a.plan.id).toBe("free");
    expect(a.entitlement).toMatchObject({ tier: "free", trialEligible: false });

    // A trial already used means checkout has none.
    await app.request("/v1/billing/checkout", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify({ interval: "month" }) });
    expect(billing.checkouts.at(-1)!.trialDays).toBeNull();
  });

  it("links the customer from checkout.session.completed and applies each event once", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const s = await signIn(app, undefined, undefined, null);
    const customer = `cus_new_${s.account.id.slice(0, 6)}`;
    const subId = `sub_new_${s.account.id.slice(0, 6)}`;
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "active"));
    const ev = event("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      client_reference_id: s.account.id,
      customer,
      subscription: subId,
      metadata: {},
    });
    expect((await deliver(app, ev)).status).toBe(200);
    const again = await deliver(app, ev);
    expect(await again.json()).toMatchObject({ duplicate: true });
    const [row] = await db()`select stripe_customer_id, plan from accounts where id = ${s.account.id}`;
    expect(row).toMatchObject({ stripe_customer_id: customer, plan: "pro" });
    const second = await app.request("/v1/billing/checkout", { method: "POST", headers: authed(s.accessToken), body: JSON.stringify({ interval: "month" }) });
    expect(second.status).toBe(409);
  });

  it("never downgrades a hand-assigned plan", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const s = await signIn(app, undefined, undefined, "internal");
    const customer = `cus_int_${s.account.id.slice(0, 6)}`;
    await db()`update accounts set stripe_customer_id = ${customer} where id = ${s.account.id}`;
    const subId = `sub_int_${s.account.id.slice(0, 6)}`;
    billing.subscriptions.set(subId, subscription(subId, customer, s.account.id, "canceled"));
    await deliver(app, event("customer.subscription.deleted", { id: subId }));
    const [row] = await db()`select plan from accounts where id = ${s.account.id}`;
    expect(row!.plan).toBe("internal");
  });

  it("lets Stripe retry when handling fails", async () => {
    const billing = new FakeBilling();
    const { app } = makeApp({ billing });
    const ev = event("customer.subscription.updated", { id: "sub_missing" });
    expect((await deliver(app, ev)).status).toBe(500);
    const [row] = await db()`select 1 from stripe_events where id = ${ev.id}`;
    expect(row).toBeUndefined();
  });
});
