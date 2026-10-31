import type { Sql } from "../db/index.js";
import type { ConfigDoc } from "../config/schema.js";

export interface Plan {
  id: string;
  name: string;
  monthlyAllowanceMicros: number;
}

/**
 * Where an account's plan comes from. Phase 1 reads `accounts.plan` and the
 * plan table in remote config. Billing (phase 4) replaces this with an
 * implementation backed by StoreKit or Stripe entitlements; the payments
 * choice is still open, so nothing else in the service depends on it.
 */
export interface PlanProvider {
  planFor(accountId: string, config: ConfigDoc): Promise<Plan>;
}

export class ConfigPlanProvider implements PlanProvider {
  constructor(private readonly sql: Sql) {}

  async planFor(accountId: string, config: ConfigDoc): Promise<Plan> {
    const [row] = await this.sql<{ plan: string }[]>`select plan from accounts where id = ${accountId}`;
    const id = row?.plan ?? "beta";
    const plan = config.plans[id];
    if (!plan) return { id, name: id, monthlyAllowanceMicros: 0 };
    return { id, ...plan };
  }
}
