import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";
import { resolvePlanAndAddons } from "../lib/plan-resolver.js";

export function registerSubscriptionTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_ai_budget",
    {
      annotations: READ_ONLY,
      title: "Get the current AI generation budget (text, image and video, storage) for the API token",
      description: `Returns the per-modality budgets bound to the current API token, plus the resolved plan, active add-ons, and which AI models the user can access. Use this to decide if an operation is affordable BEFORE calling generation tools.

THE THREE BUDGETS:
- text: words for chat / copy / prompt generation (generate_text and similar).
- image_and_video: imagen and video AI generation share this bucket. There is NO separate video quota. Consumed by generate_image, generate_ai_video_clip, generate_avatar_lipsync_clip, generate_avatar_video.
- storage: bytes for uploaded assets in the library.

Each bucket reports allowed, used, remaining, percent_used, and an optional note when over 90% used.

QUOTAS OF SEATS / WORKSPACES:
- users: current users count vs allowed.
- companies: current companies count vs allowed.

FEATURE GATING (booleans):
- followr_plus_enabled: when true, the user can use premium image and video models (nano_banana_pro, gpt_image_2, etc.). When false, only non-premium models work; the rest fail at the backend with HTTP 402.
- white_label_enabled, api_keys_enabled, getlead_enabled: other plan-bound features.

PLAN CONTEXT:
- plan: { name, label, family } where family is "smm" | "ai_studio" | "free_tier" | "unknown".
- active_addons: list of add-ons currently activated on the subscription (e.g. Followr Plus, White Label, capacity add-ons).

PRICING IS NEVER SURFACED HERE. If the user asks about prices, direct them to the Followr web (landing or Subscription page). The MCP does NOT expose costs in USD.

MODEL RECOMMENDATIONS:
_model_recommendations contains the platform default for image and video, plan-aware: when followr_plus_enabled is true the recommendation surfaces the premium-quality defaults; when false it falls back to non-premium safe defaults (nano_banana_2 for image, Wan 2 for video) and explicitly tells the agent to avoid premium models.

THE BACKEND allows going OVER nominal quotas in some cases. Buckets are soft caps for visibility, not always hard blocks. Do not assume used > total === blocked.

THE MCP DOES NOT CHANGE PLANS OR ACTIVATE ADD-ONS. Subscription mutations require Stripe Checkout and a user-provided payment method; the MCP can only read the current state. If the user wants to upgrade or add credits, redirect them to the Followr web Subscription page.

SCOPE: balance is per-token, not per-user. The same user can hold multiple tokens, each bound to a different subscription.

ALIAS: 'get_credits_balance' is the previous name and remains as a backward-compatible alias; new sessions should call 'get_ai_budget'.`,
      inputSchema: {},
    },
    aiBudgetHandler(client),
  );

  // Backward-compatible alias. Old sessions / cached tool catalogs may still
  // call 'get_credits_balance'; route it to the same handler.
  server.registerTool(
    "get_credits_balance",
    {
      annotations: READ_ONLY,
      title: "[DEPRECATED ALIAS for get_ai_budget] Get the AI generation budget",
      description: `DEPRECATED ALIAS. Use get_ai_budget instead. This name remains for back-compat with sessions started before the rename. Behavior is identical to get_ai_budget.`,
      inputSchema: {},
    },
    aiBudgetHandler(client),
  );
}

// Shared handler. Wraps the raw SubscriptionBalance into a normalized,
// plan-aware output. Intentionally drops several fields from the backend
// response that are confusing or not actionable:
//
//   - credits: a legacy counter unrelated to plan budget; reading it leads
//     to false-negative budget decisions ("you have 221 credits") when the
//     real budget is thousands of images.
//   - premium_images_allowed / premium_images_spent: confirmed 2026-05-20
//     to NOT be the gate for premium models; the actual gate is the
//     followr_plus_enabled flag (which the backend exposes as
//     plus_chat_enabled). The premium_images counter is informational at
//     best, misleading at worst.
//   - images_bonus_total / images_bonus_credits[]: empirically never moved
//     in any tested state; appear to be legacy.
//
// And ADDS:
//   - plan: resolved name + label + family.
//   - active_addons: array of add-on { name, label } from the subscription.
//   - followr_plus_enabled (renamed from backend's plus_chat_enabled).
//   - _model_recommendations: plan-aware default image and video models.
function aiBudgetHandler(client: FollowrClient) {
  return async () => {
    const balance = await client.getSubscriptionBalance();
    const bytesSpent =
      typeof balance.bytes_spent === "string"
        ? Number(balance.bytes_spent)
        : Number(balance.bytes_spent ?? 0);

    const textRemaining = Math.max(0, balance.words_allowed - balance.words_spent);
    const imageVideoRemaining = Math.max(0, balance.images_allowed - balance.images_spent);
    const bytesRemaining = Math.max(0, balance.bytes_allowed - bytesSpent);

    const textPct = balance.words_allowed > 0 ? balance.words_spent / balance.words_allowed : 0;
    const imageVideoPct =
      balance.images_allowed > 0 ? balance.images_spent / balance.images_allowed : 0;
    const storagePct = balance.bytes_allowed > 0 ? bytesSpent / balance.bytes_allowed : 0;

    const noteHigh = (pct: number) =>
      pct > 0.9 ? "over 90% used, warn the user before any batch operation" : null;

    const followrPlusEnabled = Boolean(balance.plus_chat_enabled);

    // Resolve plan + addons (best-effort, never blocks the response).
    const { plan, addons } = await resolvePlanAndAddons(client, balance);

    // Model recommendations, plan-aware. IDs use Followr's canonical format:
    // dots for major.minor versions (veo_3.1_fast, wan_2.2) and no separator
    // for some (hailuo_02_*). Underscored variants like veo_3_1_fast do NOT
    // exist in Followr and return 422 "selected model is invalid".
    const imageDefault = "nano_banana_2";
    const videoDefault = followrPlusEnabled ? "veo_3.1_fast" : "wan_2.2";
    const modelNote = followrPlusEnabled
      ? "The user can use any AI model. Default to nano_banana_2 for image and veo_3.1_fast for video. If the user asks for higher video quality, the recommended ladder is veo_3_fast then veo_3.1 then veo_3 (confirm cost with the user before veo_3)."
      : "The user has premium models blocked on the current plan. The ONLY models accessible without Followr Plus are: nano_banana_2 and z_image_turbo for image, wan_2.2 for video. Any other model (nano_banana_pro, gpt_image_2, imagen4_*, ideogram_v3, flux_pro_1.1, all Veo, all SeeDance, all Hailuo) returns HTTP 422 'selected model is invalid'. Do NOT attempt those calls; explain the plan limitation and direct the user to the Followr web to activate the Followr Plus add-on. The MCP cannot activate add-ons.";

    const wrapped = {
      summary: `Plan: ${plan.label} (${plan.family}). Text: ${balance.words_spent}/${balance.words_allowed}. Image and video (shared): ${balance.images_spent}/${balance.images_allowed}. Storage: ${(bytesSpent / 1e9).toFixed(2)}GB / ${(balance.bytes_allowed / 1e9).toFixed(2)}GB. Followr Plus: ${followrPlusEnabled ? "yes" : "no"}.`,
      plan,
      active_addons: addons,
      text: {
        allowed: balance.words_allowed,
        used: balance.words_spent,
        remaining: textRemaining,
        percent_used: Number(textPct.toFixed(3)),
        renews_at: balance.words_renews_at,
        note: noteHigh(textPct),
      },
      image_and_video: {
        allowed: balance.images_allowed,
        used: balance.images_spent,
        remaining: imageVideoRemaining,
        percent_used: Number(imageVideoPct.toFixed(3)),
        note:
          noteHigh(imageVideoPct) ??
          "image and video AI generation share this bucket; there is no separate video quota",
      },
      storage: {
        allowed_gb: Number((balance.bytes_allowed / 1e9).toFixed(2)),
        used_gb: Number((bytesSpent / 1e9).toFixed(2)),
        remaining_gb: Number((bytesRemaining / 1e9).toFixed(2)),
        percent_used: Number(storagePct.toFixed(3)),
        note: noteHigh(storagePct),
      },
      users: {
        allowed: balance.users_allowed,
        current: balance.users_spent,
      },
      companies: {
        allowed: balance.companies_allowed,
        current: balance.companies_spent,
      },
      followr_plus_enabled: followrPlusEnabled,
      white_label_enabled: Boolean(balance.white_label_enabled),
      api_keys_enabled: Boolean(balance.api_keys_enabled),
      getlead_enabled: Boolean(balance.getlead_enabled),
      _model_recommendations: {
        image_default: imageDefault,
        video_default: videoDefault,
        note: modelNote,
      },
      _what_to_use_for_decisions:
        "For image or video generation, read image_and_video.remaining and check followr_plus_enabled before suggesting premium models. For text, read text.remaining. Soft caps: the backend can allow some overflow; do not assume used > total === blocked. The MCP does not surface prices, payment methods or coupons; redirect the user to the Followr web for that.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(wrapped, null, 2) }] };
  };
}
