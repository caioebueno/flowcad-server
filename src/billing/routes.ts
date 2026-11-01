import { Hono } from "hono";
import { z } from "zod";
import type Stripe from "stripe";
import type { AppEnv, Deps } from "../deps.js";
import type { Sql } from "../db/index.js";
import { ApiError } from "../errors.js";
import { parseJson } from "../util/validate.js";
import { log } from "../logger.js";
import { canBuyPack, entitlementFor, HAND_ASSIGNED_PLANS, LIVE_STATUSES } from "./entitlement.js";
import { creditBalance, creditPeriod, creditsSummary, grantPack, revokePack } from "./credits.js";
import type { ConfigDoc } from "../config/schema.js";
import type { BillingGateway } from "./stripe.js";

const unavailable = () => new ApiError(503, "billing_unavailable", "Billing isn't set up on this server");

const toDate = (unix: number | null | undefined) => (unix ? new Date(unix * 1000) : null);

/**
 * Writes a Stripe subscription into `subscriptions` and moves the account's
 * plan between free and pro to match. Hand-assigned plans are left alone.
 */
export async function syncSubscription(sql: Sql, sub: Stripe.Subscription): Promise<string | null> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const metaAccount = sub.metadata?.account_id;
  const [account] = await sql<{ id: string }[]>`
    select id from accounts where stripe_customer_id = ${customerId}
    ${metaAccount ? sql`or id = ${metaAccount}` : sql``}
    order by (stripe_customer_id = ${customerId}) desc limit 1`;
  if (!account) {
    log.warn("stripe_subscription_unmatched", { subscription: sub.id });
    return null;
  }
  const item = sub.items?.data?.[0] as
    | (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number })
    | undefined;
  // Newer API versions keep the period on the item; older ones on the subscription.
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const periodStart = item?.current_period_start ?? legacy.current_period_start;
  const periodEnd = item?.current_period_end ?? legacy.current_period_end;
  const interval = item?.price?.recurring?.interval ?? null;

  await sql.begin(async (tx) => {
    await tx`
      insert into subscriptions (stripe_subscription_id, account_id, stripe_price_id, price_interval, status,
                                 current_period_start, current_period_end, trial_end, cancel_at_period_end, updated_at)
      values (${sub.id}, ${account.id}, ${item?.price?.id ?? null}, ${interval}, ${sub.status},
              ${toDate(periodStart)}, ${toDate(periodEnd)}, ${toDate(sub.trial_end)}, ${sub.cancel_at_period_end ?? false}, now())
      on conflict (stripe_subscription_id) do update set
        status = excluded.status, stripe_price_id = excluded.stripe_price_id, price_interval = excluded.price_interval,
        current_period_start = excluded.current_period_start,
        current_period_end = excluded.current_period_end, trial_end = excluded.trial_end,
        cancel_at_period_end = excluded.cancel_at_period_end, updated_at = now()`;
    await tx`update accounts set stripe_customer_id = coalesce(stripe_customer_id, ${customerId}) where id = ${account.id}`;
    if (sub.trial_end || sub.status === "trialing") {
      await tx`update accounts set trial_used_at = coalesce(trial_used_at, now()) where id = ${account.id}`;
    }
    const [live] = await tx`
      select 1 from subscriptions where account_id = ${account.id} and status = any(${LIVE_STATUSES}) limit 1`;
    const [{ plan } = { plan: "free" }] = await tx<{ plan: string }[]>`select plan from accounts where id = ${account.id} for update`;
    if (!HAND_ASSIGNED_PLANS.has(plan)) {
      await tx`update accounts set plan = ${live ? "pro" : "free"} where id = ${account.id}`;
    }
  });
  return account.id;
}

function subscriptionIdOf(obj: unknown): string | null {
  const o = obj as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const ref = o.subscription ?? o.parent?.subscription_details?.subscription ?? null;
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

const idOf = (ref: string | { id: string } | null | undefined) => (!ref ? null : typeof ref === "string" ? ref : ref.id);

async function handleEvent(sql: Sql, billing: BillingGateway, config: ConfigDoc, event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "payment") {
        // A credit pack. Granted here and on payment_intent.succeeded, whichever comes first.
        const accountId = session.metadata?.account_id;
        const paymentIntentId = idOf(session.payment_intent);
        if (session.metadata?.kind === "credit_pack" && accountId && paymentIntentId && session.payment_status === "paid") {
          await grantPack(sql, config, {
            accountId,
            paymentIntentId,
            amountCents: session.amount_total ?? null,
            currency: session.currency ?? null,
          });
        }
        return;
      }
      const accountId = session.client_reference_id ?? session.metadata?.account_id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (accountId && customerId) {
        await sql`update accounts set stripe_customer_id = coalesce(stripe_customer_id, ${customerId}) where id = ${accountId}`;
      }
      const subId = subscriptionIdOf(session);
      if (subId) await syncSubscription(sql, await billing.retrieveSubscription(subId));
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      // Fetch the current state rather than trusting the event's copy, which can be out of order.
      await syncSubscription(sql, await billing.retrieveSubscription((event.data.object as Stripe.Subscription).id));
      return;
    case "invoice.payment_failed":
    case "invoice.paid": {
      const subId = subscriptionIdOf(event.data.object);
      if (subId) await syncSubscription(sql, await billing.retrieveSubscription(subId));
      return;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const accountId = pi.metadata?.account_id;
      if (pi.metadata?.kind === "credit_pack" && accountId) {
        const [exists] = await sql`select 1 from accounts where id = ${accountId}`;
        if (exists) {
          await grantPack(sql, config, { accountId, paymentIntentId: pi.id, amountCents: pi.amount_received, currency: pi.currency });
        }
      }
      return;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId = idOf(charge.payment_intent);
      if (charge.refunded && paymentIntentId) await revokePack(sql, paymentIntentId);
      return;
    }
    default:
      return;
  }
}

/** Unauthenticated: Stripe's webhook and the pages Checkout returns to. */
export function billingPublicRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.post("/stripe/webhook", async (c) => {
    if (!deps.billing) throw unavailable();
    const signature = c.req.header("stripe-signature");
    const raw = await c.req.text();
    let event: Stripe.Event;
    try {
      if (!signature) throw new Error("no signature");
      event = await deps.billing.verifyWebhook(raw, signature);
    } catch {
      log.warn("stripe_webhook_bad_signature");
      throw new ApiError(400, "invalid_request", "Bad signature");
    }
    const [fresh] = await deps.sql`
      insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing returning id`;
    if (!fresh) return c.json({ received: true, duplicate: true });
    try {
      await handleEvent(deps.sql, deps.billing, (await deps.config.current()).doc, event);
    } catch (err) {
      // Forget the event so Stripe's retry is handled, and answer 500 so it retries.
      await deps.sql`delete from stripe_events where id = ${event.id}`;
      log.error("stripe_webhook_failed", { event: event.id, type: event.type, err: (err as Error).message });
      throw err;
    }
    log.info("stripe_webhook", { event: event.id, type: event.type });
    return c.json({ received: true });
  });

  // Checkout and the portal return here; the page hands control back to the app.
  const returnPage = (target: string, title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta http-equiv="refresh" content="0;url=${target}">
<style>body{font:16px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1d1d1f;background:#fff}
@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}a{color:#0a84ff}</style></head>
<body><main><p>${title}</p><p><a href="${target}">Return to Keel</a></p></main>
<script>location.href=${JSON.stringify(target)}</script></body></html>`;

  app.get("/return/success", (c) => c.html(returnPage("keel://billing/success", "You're all set. Returning to Keel…")));
  app.get("/return/pack-success", (c) => c.html(returnPage("keel://billing/pack-success", "Credits added. Returning to Keel…")));
  app.get("/return/cancel", (c) => c.html(returnPage("keel://billing/cancel", "Checkout cancelled. Returning to Keel…")));
  app.get("/return/portal", (c) => c.html(returnPage("keel://billing/portal", "Returning to Keel…")));

  return app;
}

/** Signed-in billing routes. */
export function billingRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  /** The account's Stripe customer, created on first use with the account id in its metadata. */
  const customerFor = async (accountId: string) => {
    const [account] = await deps.sql<{ email: string | null; email_relay: string | null; stripe_customer_id: string | null }[]>`
      select email, email_relay, stripe_customer_id from accounts where id = ${accountId}`;
    if (account!.stripe_customer_id) return account!.stripe_customer_id;
    const created = await deps.billing!.createCustomer({ accountId, email: account!.email ?? account!.email_relay });
    const [set] = await deps.sql<{ stripe_customer_id: string }[]>`
      update accounts set stripe_customer_id = coalesce(stripe_customer_id, ${created}) where id = ${accountId}
      returning stripe_customer_id`;
    return set!.stripe_customer_id;
  };

  app.get("/plans", async (c) => {
    const { accountId } = c.get("auth");
    const { doc } = await deps.config.current();
    const entitlement = await entitlementFor(deps.sql, accountId, doc);
    const prices = deps.billing ? await deps.billing.prices() : [];
    const pack = deps.billing ? await deps.billing.packPrice() : null;
    return c.json({
      plans: [
        { id: "free", name: doc.plans.free?.name ?? "Free", prices: [] },
        {
          id: "pro",
          name: doc.plans.pro?.name ?? "Keel Pro",
          prices: prices.map((p) => ({ interval: p.interval, amount: p.unitAmount, currency: p.currency })),
        },
      ],
      trialDays: doc.billing.trialDays,
      trialCredits: doc.billing.trialCredits,
      monthlyCredits: doc.plans.pro?.monthlyCredits ?? 0,
      pack:
        pack && pack.unitAmount !== null
          ? { credits: doc.billing.pack.credits, amount: pack.unitAmount, currency: pack.currency }
          : null,
      trialEligible: entitlement.trialEligible,
      current: entitlement,
      billingAvailable: !!deps.billing && prices.length > 0,
    });
  });

  const CheckoutBody = z.strictObject({
    interval: z.enum(["month", "year"]),
    /** Where the upgrade started in the app, kept on the Stripe session for reporting. */
    context: z.string().max(64).optional(),
  });

  app.post("/checkout", async (c) => {
    if (!deps.billing) throw unavailable();
    const { accountId } = c.get("auth");
    const body = await parseJson(c, CheckoutBody);
    const priceId = deps.billing.priceFor(body.interval);
    if (!priceId) throw unavailable();
    const { doc } = await deps.config.current();

    const entitlement = await entitlementFor(deps.sql, accountId, doc);
    if (entitlement.source === "stripe" || entitlement.source === "trial") {
      throw new ApiError(409, "already_subscribed", "This account already has Pro. Manage it from the billing portal.");
    }

    const customerId = await customerFor(accountId);
    const url = await deps.billing.createCheckout({
      customerId,
      priceId,
      trialDays: entitlement.trialEligible && doc.billing.trialDays > 0 ? doc.billing.trialDays : null,
      accountId,
      context: body.context ?? null,
      successUrl: `${deps.publicBaseUrl}/v1/billing/return/success`,
      cancelUrl: `${deps.publicBaseUrl}/v1/billing/return/cancel`,
    });
    return c.json({ url });
  });

  const PackBody = z.strictObject({ context: z.string().max(64).optional() });

  app.post("/packs/checkout", async (c) => {
    const { accountId } = c.get("auth");
    const body = await parseJson(c, PackBody);
    const { doc } = await deps.config.current();
    const entitlement = await entitlementFor(deps.sql, accountId, doc);
    if (entitlement.tier !== "pro") throw new ApiError(403, "plan_required", "Credit packs are part of Keel Pro");
    if (entitlement.source === "trial") {
      throw new ApiError(409, "packs_unavailable_during_trial", "Credit packs can be bought once the trial ends");
    }
    const priceId = deps.billing?.packPriceId();
    if (!deps.billing || !priceId) throw unavailable();
    const url = await deps.billing.createPackCheckout({
      customerId: await customerFor(accountId),
      priceId,
      accountId,
      context: body.context ?? null,
      successUrl: `${deps.publicBaseUrl}/v1/billing/return/pack-success`,
      cancelUrl: `${deps.publicBaseUrl}/v1/billing/return/cancel`,
    });
    return c.json({ url });
  });

  // "Start Pro now": ends the trial early, so billing and a fresh period of monthly credits start.
  app.post("/trial/end", async (c) => {
    if (!deps.billing) throw unavailable();
    const { accountId } = c.get("auth");
    const [sub] = await deps.sql<{ stripe_subscription_id: string }[]>`
      select stripe_subscription_id from subscriptions
      where account_id = ${accountId} and status = 'trialing' order by updated_at desc limit 1`;
    if (!sub) throw new ApiError(409, "not_trialing", "There's no trial to end");
    const updated = await deps.billing.endTrial(sub.stripe_subscription_id);
    await syncSubscription(deps.sql, updated);
    const { doc } = await deps.config.current();
    const entitlement = await entitlementFor(deps.sql, accountId, doc);
    const plan = await deps.plans.planFor(accountId, doc);
    const period = await creditPeriod(deps.sql, accountId, plan, doc);
    const credits = period
      ? creditsSummary(doc, period, await creditBalance(deps.sql, accountId, period), canBuyPack(deps, entitlement))
      : null;
    return c.json({ entitlement, credits });
  });

  app.post("/portal", async (c) => {
    if (!deps.billing) throw unavailable();
    const { accountId } = c.get("auth");
    const [account] = await deps.sql<{ stripe_customer_id: string | null }[]>`
      select stripe_customer_id from accounts where id = ${accountId}`;
    if (!account?.stripe_customer_id) throw new ApiError(404, "not_found", "No billing account yet");
    const url = await deps.billing.createPortal({
      customerId: account.stripe_customer_id,
      returnUrl: `${deps.publicBaseUrl}/v1/billing/return/portal`,
    });
    return c.json({ url });
  });

  return app;
}
