import type { Sql } from "../db/index.js";
import type { ConfigDoc } from "../config/schema.js";

export interface Entitlement {
  tier: "free" | "pro";
  /** Where Pro comes from: a paid Stripe subscription, its trial, or a hand-assigned plan. */
  source: "stripe" | "trial" | "internal" | null;
  /** When the current paid period or trial ends; null for Free and internal plans. */
  expiresAt: string | null;
  trialEligible: boolean;
  /** True when Pro ends at expiresAt (cancelled, still in its paid period). */
  cancelAtPeriodEnd: boolean;
  /** Set while Stripe is retrying a failed payment and Pro is still on. */
  paymentFailed: boolean;
}

/** Subscription states that keep Pro on. */
export const LIVE_STATUSES = ["trialing", "active", "past_due"];

/** Plans Stripe never changes. */
export const HAND_ASSIGNED_PLANS = new Set(["beta", "internal"]);

export async function entitlementFor(sql: Sql, accountId: string, config: ConfigDoc): Promise<Entitlement> {
  const [a] = await sql<{ plan: string; trial_used_at: Date | null }[]>`
    select plan, trial_used_at from accounts where id = ${accountId}`;
  const plan = a ? config.plans[a.plan] : undefined;
  const tier = plan?.tier ?? "free";
  const [sub] = await sql<
    { status: string; current_period_end: Date | null; trial_end: Date | null; cancel_at_period_end: boolean }[]
  >`select status, current_period_end, trial_end, cancel_at_period_end from subscriptions
    where account_id = ${accountId} and status = any(${LIVE_STATUSES})
    order by updated_at desc limit 1`;

  let source: Entitlement["source"] = null;
  let expiresAt: Date | null = null;
  if (a && HAND_ASSIGNED_PLANS.has(a.plan) && tier === "pro") source = "internal";
  else if (sub && tier === "pro") {
    source = sub.status === "trialing" ? "trial" : "stripe";
    expiresAt = sub.status === "trialing" ? (sub.trial_end ?? sub.current_period_end) : sub.current_period_end;
  }
  return {
    tier,
    source,
    expiresAt: expiresAt?.toISOString() ?? null,
    trialEligible: !a?.trial_used_at,
    cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
    paymentFailed: sub?.status === "past_due",
  };
}
