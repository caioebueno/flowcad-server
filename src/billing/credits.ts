import type { Sql } from "../db/index.js";
import type { ConfigDoc } from "../config/schema.js";
import type { Plan } from "./plans.js";
import { HAND_ASSIGNED_PLANS, LIVE_STATUSES } from "./entitlement.js";

/**
 * AI credits (AI spec > Spec 8). Costs stay in micro dollars everywhere on the
 * server; credits are only how they are shown. One credit is 1/perDollar of a
 * dollar, so 150 credits a dollar makes a credit 6,666.67 micro dollars.
 */
export const microsPerCredit = (config: ConfigDoc) => 1_000_000 / config.credits.perDollar;

export interface CreditPeriod {
  start: Date;
  end: Date;
  isTrial: boolean;
  limitCredits: number;
  limitMicros: number;
}

function calendarMonth(at: Date) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * The credit period an account is in now. Stripe plans follow the subscription:
 * the trial is one period with the trial credits, then each billing period gets
 * the plan's monthly credits. Hand-assigned plans use the calendar month.
 * Free accounts have no period (and no AI).
 */
export async function creditPeriod(sql: Sql, accountId: string, plan: Plan, config: ConfigDoc, now = new Date()): Promise<CreditPeriod | null> {
  if (plan.tier !== "pro") return null;
  const mpc = microsPerCredit(config);
  const make = (start: Date, end: Date, isTrial: boolean): CreditPeriod => {
    const limitCredits = isTrial ? config.billing.trialCredits : plan.monthlyCredits;
    return { start, end, isTrial, limitCredits, limitMicros: Math.round(limitCredits * mpc) };
  };
  if (!HAND_ASSIGNED_PLANS.has(plan.id)) {
    const [sub] = await sql<{ status: string; current_period_start: Date | null; current_period_end: Date | null; trial_end: Date | null }[]>`
      select status, current_period_start, current_period_end, trial_end from subscriptions
      where account_id = ${accountId} and status = any(${LIVE_STATUSES})
      order by updated_at desc limit 1`;
    const end = sub ? (sub.status === "trialing" ? (sub.trial_end ?? sub.current_period_end) : sub.current_period_end) : null;
    if (sub?.current_period_start && end && end > now) return make(sub.current_period_start, end, sub.status === "trialing");
  }
  const { start, end } = calendarMonth(now);
  return make(start, end, false);
}

export interface CreditBalance {
  monthlyUsedMicros: number;
  extraMicros: number;
  extraExpiresAt: Date | null;
}

export async function creditBalance(sql: Sql, accountId: string, period: CreditPeriod): Promise<CreditBalance> {
  const [a] = await sql<{ used_micros: number }[]>`
    select used_micros from allowances where account_id = ${accountId} and period_start = ${period.start}`;
  const [g] = await sql<{ remaining: number; expires: Date | null }[]>`
    select coalesce(sum(remaining_micros), 0)::bigint as remaining, min(expires_at) as expires
    from credit_grants where account_id = ${accountId} and remaining_micros > 0 and expires_at > now()`;
  return { monthlyUsedMicros: a?.used_micros ?? 0, extraMicros: g?.remaining ?? 0, extraExpiresAt: g?.expires ?? null };
}

export const isExhausted = (period: CreditPeriod, b: Pick<CreditBalance, "monthlyUsedMicros" | "extraMicros">) =>
  b.monthlyUsedMicros >= period.limitMicros && b.extraMicros <= 0;

/** Credits left, monthly plus extra, rounded down so the app never shows a credit that isn't there. */
export function creditsLeft(config: ConfigDoc, period: CreditPeriod, b: Pick<CreditBalance, "monthlyUsedMicros" | "extraMicros">) {
  const mpc = microsPerCredit(config);
  return Math.max(0, period.limitCredits - usedCredits(b.monthlyUsedMicros, mpc)) + Math.floor(b.extraMicros / mpc + 1e-9);
}

/** Credits used, rounded up, so used plus left always equals the limit. */
const usedCredits = (micros: number, mpc: number) => (micros <= 0 ? 0 : Math.ceil(micros / mpc - 1e-6));

/** True when 20% or less of the period's credits is left (the threshold lives in config). */
export function isLow(config: ConfigDoc, period: CreditPeriod, monthlyUsedMicros: number) {
  if (period.limitMicros <= 0) return true;
  return monthlyUsedMicros >= period.limitMicros * config.limits.allowanceWarningRatio;
}

/** The `credits` block of GET /account and POST /billing/trial/end. */
export function creditsSummary(config: ConfigDoc, period: CreditPeriod, b: CreditBalance, canBuyPack: boolean) {
  const mpc = microsPerCredit(config);
  const monthlyUsed = Math.min(period.limitCredits, usedCredits(b.monthlyUsedMicros, mpc));
  return {
    monthlyUsed,
    monthlyLimit: period.limitCredits,
    extra: Math.floor(b.extraMicros / mpc + 1e-9),
    extraExpiresAt: b.extraMicros > 0 ? (b.extraExpiresAt?.toISOString() ?? null) : null,
    resetsAt: period.end.toISOString(),
    isTrial: period.isTrial,
    low: isLow(config, period, b.monthlyUsedMicros),
    exhausted: isExhausted(period, b),
    left: creditsLeft(config, period, b),
    canBuyPack,
  };
}

/**
 * Adds one pack's credits. Idempotent on the Stripe payment intent, because
 * both checkout.session.completed and payment_intent.succeeded announce it.
 */
export async function grantPack(
  sql: Sql,
  config: ConfigDoc,
  input: { accountId: string; paymentIntentId: string; amountCents: number | null; currency: string | null },
): Promise<boolean> {
  const { credits, validMonths } = config.billing.pack;
  const micros = Math.round(credits * microsPerCredit(config));
  const rows = await sql`
    insert into credit_grants (account_id, source, credits, granted_micros, remaining_micros, amount_cents, currency,
                               stripe_payment_intent_id, expires_at)
    values (${input.accountId}, 'pack', ${credits}, ${micros}, ${micros}, ${input.amountCents}, ${input.currency},
            ${input.paymentIntentId}, now() + make_interval(months => ${validMonths}))
    on conflict (stripe_payment_intent_id) do nothing
    returning id`;
  return rows.length > 0;
}

/** A refunded pack stops counting; what was already used stays used. */
export async function revokePack(sql: Sql, paymentIntentId: string) {
  await sql`update credit_grants set remaining_micros = 0 where stripe_payment_intent_id = ${paymentIntentId}`;
}
