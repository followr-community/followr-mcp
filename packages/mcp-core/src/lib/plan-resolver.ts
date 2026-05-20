// Plan + add-on resolver.
//
// Followr's /api/subscriptions endpoint returns a subscription with items[]
// containing Stripe price stripe_ids, but it does NOT tell you the plan
// name, the addons activated, or the plan family. To get that, you need to
// match each item.stripe_id against the prices arrays of all products in
// /api/products.
//
// This module does that matching and returns a normalized ResolvedPlan +
// list of active add-ons. Consumed by tools/subscription.ts to surface
// plan context to the agent.
//
// Plan family inference (verified empirically 2026-05-20):
//   - Catalog plan id 20 (name "free"): if balance shows non-zero caps,
//     the user is on a server-side "free tier" with overrides (different
//     from the all-zero catalog Free). We classify as "free_tier" then.
//   - Catalog plan ids 1, 2, 3, 10, 21 (pro/team/agency/essential/enterprise):
//     "smm" family.
//   - Catalog plan ids 39, 40, 41 (starter/scale/hardcore): "ai_studio"
//     family.
//   - Anything else: "unknown".
//
// IMPORTANT: prices and amounts from the catalog are NOT exposed by this
// resolver. The caller surfaces only name + label + family + addons.

import type {
  FollowrClient,
  Product,
  Subscription,
  SubscriptionBalance,
} from "@followr-mcp/shared";

export type PlanFamily = "smm" | "ai_studio" | "free_tier" | "unknown";

export interface ResolvedPlan {
  /** Internal name from the catalog (e.g. "pro", "enterprise", "scale"). */
  name: string;
  /** Display label from the catalog (e.g. "Pro", "Enterprise"). */
  label: string;
  /** Coarse family used by the agent to reason about defaults. */
  family: PlanFamily;
}

export interface ResolvedAddon {
  name: string;
  label: string;
}

const SMM_PLAN_NAMES = new Set(["pro", "team", "agency", "enterprise", "essential"]);
const AI_STUDIO_PLAN_NAMES = new Set(["starter", "scale", "hardcore"]);

function inferPlanFamily(name: string, balance: SubscriptionBalance): PlanFamily {
  const n = name.toLowerCase();
  if (SMM_PLAN_NAMES.has(n)) return "smm";
  if (AI_STUDIO_PLAN_NAMES.has(n)) return "ai_studio";
  if (n === "free") {
    // The catalog "free" product has all amounts at 0. When the actual
    // balance reports non-zero allowances, the user is on a server-side
    // "free tier" with overrides not visible in the catalog. Otherwise
    // we treat it as truly empty.
    const hasCaps = balance.words_allowed > 0 || balance.images_allowed > 0;
    return hasCaps ? "free_tier" : "unknown";
  }
  return "unknown";
}

/**
 * Resolve the plan + active add-ons for the token's subscription. Returns
 * { plan, addons } with the plan classified by family. Falls back to
 * "unknown" when subscription or catalog lookups fail or there is no match.
 *
 * Best-effort: both API calls are independent. If either fails, the
 * resolver returns whatever it can with "unknown" placeholders rather
 * than throwing.
 */
export async function resolvePlanAndAddons(
  client: FollowrClient,
  balance: SubscriptionBalance,
): Promise<{ plan: ResolvedPlan; addons: ResolvedAddon[] }> {
  const [subscriptionResult, productsResult] = await Promise.allSettled([
    client.getSubscription(),
    client.listProductsAll({ includePrices: true }),
  ]);

  const subscription: Subscription | null =
    subscriptionResult.status === "fulfilled" ? subscriptionResult.value : null;
  const products: Product[] =
    productsResult.status === "fulfilled" ? productsResult.value : [];

  const fallback: ResolvedPlan = { name: "unknown", label: "Unknown", family: "unknown" };

  if (!subscription || products.length === 0) {
    return { plan: fallback, addons: [] };
  }

  // Index every price stripe_id to its product for O(1) lookup.
  const priceToProduct = new Map<string, Product>();
  for (const p of products) {
    if (!p.prices) continue;
    for (const price of p.prices) {
      priceToProduct.set(price.stripe_id, p);
    }
  }

  let plan: ResolvedPlan = fallback;
  const addons: ResolvedAddon[] = [];
  for (const item of subscription.items) {
    const product = priceToProduct.get(item.stripe_id);
    if (!product) continue;
    if (product.type === "plan") {
      plan = {
        name: product.name,
        label: product.label,
        family: inferPlanFamily(product.name, balance),
      };
    } else if (product.type === "add-on") {
      addons.push({ name: product.name, label: product.label });
    }
  }

  return { plan, addons };
}
