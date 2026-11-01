import type { Sql } from "../db/index.js";
import type { ConfigDoc } from "../config/schema.js";

export interface Plan {
  id: string;
  name: string;
  tier: "free" | "pro";
  monthlyCredits: number;
}

/**
 * Where an account's plan comes from: `accounts.plan`, looked up in the plan
 * table in remote config. Stripe webhooks (src/billing/webhook.ts) are the
 * only thing that moves an account between "free" and "pro".
 */
export interface PlanProvider {
  planFor(accountId: string, config: ConfigDoc): Promise<Plan>;
}

export class ConfigPlanProvider implements PlanProvider {
  constructor(private readonly sql: Sql) {}

  async planFor(accountId: string, config: ConfigDoc): Promise<Plan> {
    const [row] = await this.sql<{ plan: string }[]>`select plan from accounts where id = ${accountId}`;
    const id = row?.plan ?? "free";
    const plan = config.plans[id];
    if (!plan) return { id, name: id, tier: "free", monthlyCredits: 0 };
    return { id, ...plan };
  }
}
