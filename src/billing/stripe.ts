import Stripe from "stripe";

export type Interval = "month" | "year";

export interface PriceInfo {
  interval: Interval;
  priceId: string;
  /** Smallest currency unit, e.g. cents. */
  unitAmount: number | null;
  currency: string;
}

export interface CheckoutInput {
  customerId: string;
  priceId: string;
  trialDays: number | null;
  accountId: string;
  context: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface PackCheckoutInput {
  customerId: string;
  priceId: string;
  accountId: string;
  context: string | null;
  successUrl: string;
  cancelUrl: string;
}

/**
 * The few Stripe calls Keel makes, behind an interface so tests don't reach
 * Stripe. Webhook signature checks run locally and use the real SDK in tests.
 */
export interface BillingGateway {
  priceFor(interval: Interval): string | null;
  prices(): Promise<PriceInfo[]>;
  /** The one-time price of a credit pack, or null when packs aren't configured. */
  packPriceId(): string | null;
  packPrice(): Promise<{ unitAmount: number | null; currency: string } | null>;
  createPackCheckout(input: PackCheckoutInput): Promise<string>;
  /** Ends a trial now so billing starts ("Start Pro now"), and returns the updated subscription. */
  endTrial(subscriptionId: string): Promise<Stripe.Subscription>;
  createCustomer(input: { accountId: string; email: string | null }): Promise<string>;
  createCheckout(input: CheckoutInput): Promise<string>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<string>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event>;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: Partial<Record<Interval, string>>;
  packPrice?: string | null;
  automaticTax: boolean;
}

export class StripeGateway implements BillingGateway {
  readonly stripe: Stripe;
  private priceCache: { at: number; value: PriceInfo[] } | null = null;
  private packCache: { at: number; value: { unitAmount: number | null; currency: string } } | null = null;

  constructor(private readonly cfg: StripeConfig) {
    this.stripe = new Stripe(cfg.secretKey, { maxNetworkRetries: 2, appInfo: { name: "keel-account-service" } });
  }

  priceFor(interval: Interval) {
    return this.cfg.prices[interval] ?? null;
  }

  async prices() {
    if (this.priceCache && Date.now() - this.priceCache.at < 10 * 60_000) return this.priceCache.value;
    const value: PriceInfo[] = [];
    for (const interval of ["month", "year"] as const) {
      const id = this.cfg.prices[interval];
      if (!id) continue;
      const p = await this.stripe.prices.retrieve(id);
      value.push({ interval, priceId: id, unitAmount: p.unit_amount, currency: p.currency });
    }
    this.priceCache = { at: Date.now(), value };
    return value;
  }

  packPriceId() {
    return this.cfg.packPrice ?? null;
  }

  async packPrice() {
    const id = this.cfg.packPrice;
    if (!id) return null;
    if (this.packCache && Date.now() - this.packCache.at < 10 * 60_000) return this.packCache.value;
    const p = await this.stripe.prices.retrieve(id);
    const value = { unitAmount: p.unit_amount, currency: p.currency };
    this.packCache = { at: Date.now(), value };
    return value;
  }

  async createPackCheckout(input: PackCheckoutInput) {
    const metadata = { account_id: input.accountId, kind: "credit_pack", context: input.context ?? "" };
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      customer: input.customerId,
      client_reference_id: input.accountId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata,
      // The payment intent carries the account too, so payment_intent.succeeded alone can grant the credits.
      payment_intent_data: { metadata },
      automatic_tax: { enabled: this.cfg.automaticTax },
      ...(this.cfg.automaticTax ? { customer_update: { address: "auto" as const } } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Checkout session has no URL");
    return session.url;
  }

  endTrial(subscriptionId: string) {
    return this.stripe.subscriptions.update(subscriptionId, { trial_end: "now" });
  }

  async createCustomer({ accountId, email }: { accountId: string; email: string | null }) {
    const customer = await this.stripe.customers.create(
      { email: email ?? undefined, metadata: { account_id: accountId } },
      { idempotencyKey: `customer-${accountId}` },
    );
    return customer.id;
  }

  async createCheckout(input: CheckoutInput) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.accountId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      subscription_data: {
        metadata: { account_id: input.accountId },
        ...(input.trialDays
          ? {
              trial_period_days: input.trialDays,
              // The trial needs a card; without one it ends rather than turning into an unpaid subscription.
              trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
            }
          : {}),
      },
      payment_method_collection: "always",
      metadata: { account_id: input.accountId, context: input.context ?? "" },
      allow_promotion_codes: true,
      automatic_tax: { enabled: this.cfg.automaticTax },
      ...(this.cfg.automaticTax ? { customer_update: { address: "auto" as const } } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("Checkout session has no URL");
    return session.url;
  }

  async createPortal({ customerId, returnUrl }: { customerId: string; returnUrl: string }) {
    const session = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return session.url;
  }

  retrieveSubscription(id: string) {
    return this.stripe.subscriptions.retrieve(id);
  }

  verifyWebhook(rawBody: string, signature: string) {
    return this.stripe.webhooks.constructEventAsync(rawBody, signature, this.cfg.webhookSecret);
  }
}
