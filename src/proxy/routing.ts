import { tierRank, type ConfigDoc, type TaskProfile, type TaskType, type Tier } from "../config/schema.js";
import type { TurnBody } from "./request.js";

/**
 * The tier a turn runs at: what the app asked for, raised to the task type's
 * floor. Null when tiered routing is off or the app sent no tier, which keeps
 * the routing the server had before tiers.
 */
export function effectiveTier(doc: ConfigDoc, body: Pick<TurnBody, "taskType" | "tier">): Tier | null {
  const routing = doc.routing;
  if (!routing?.tiers || !body.tier) return null;
  const floor = routing.floors[body.taskType as TaskType];
  return floor && tierRank(floor) > tierRank(body.tier) ? floor : body.tier;
}

/**
 * The task type's profile moved onto a mid or top tier's model and effort.
 * The output cap and task budget stay the task type's. Haiku has no
 * "updates" thinking display and no refusal fallback; the other Claude
 * models the tiers use have both.
 */
export function tierProfile(base: TaskProfile, tier: { model: string; effort: TaskProfile["effort"] }): TaskProfile {
  const haiku = tier.model.startsWith("claude-haiku");
  return { ...base, model: tier.model, effort: tier.effort, thinkingUpdates: !haiku, refusalFallback: !haiku };
}

/**
 * Which profiles serve a turn. The cheap tier (and no tier) tries the
 * self-hosted model first, with the task type's Claude profile behind it;
 * mid and top go straight to their Claude model.
 */
export function routeTurn(
  doc: ConfigDoc,
  body: Pick<TurnBody, "taskType" | "tier">,
  typeProfile: TaskProfile,
  selfProfile: TaskProfile | null,
): { tier: Tier | null; profile: TaskProfile; selfProfile: TaskProfile | null } {
  const tier = effectiveTier(doc, body);
  if (tier === "mid" || tier === "top") {
    return { tier, profile: tierProfile(typeProfile, doc.routing![tier]), selfProfile: null };
  }
  return { tier, profile: typeProfile, selfProfile };
}
