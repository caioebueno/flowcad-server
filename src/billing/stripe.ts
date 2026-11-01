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

/**
 * The few Stripe calls Keel makes, behind an interface so tests don't reach
 * Stripe. Webhook signature checks run locally and use the real SDK in tests.
 */
export interface BillingGateway {
  priceFor(interval: Interval): string | null;
  prices(): Promise<PriceInfo[]>;
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
  automaticTax: boolean;
}

export class StripeGateway implements BillingGateway {
  readonly stripe: Stripe;
  private priceCache: { at: number; value: PriceInfo[] } | null = null;

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
        ...(input.trialDays ? { trial_period_days: input.trialDays } : {}),
      },
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
