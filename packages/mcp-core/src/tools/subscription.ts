import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RegisterOptions } from "../index.js";
import { READ_ONLY } from "../lib/annotations.js";

export function registerSubscriptionTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_ai_budget",
    {
      annotations: READ_ONLY,
      title: "Get the current AI generation budget (text, image, video, storage) for the API token",
      description: `Returns four PER-MODALITY budgets bound to the current API token. Use these to decide if an operation is affordable BEFORE calling generation tools.

THE FOUR BUDGETS:
- ai_text_budget: text generation (chat, copies, prompts). Consumed by generate_text and similar.
- ai_image_and_video_budget: BOTH image and video generation share this bucket. Video does NOT have a separate quota. Consumed by generate_image, generate_ai_video_clip, generate_avatar_lipsync_clip, generate_avatar_video.
- ai_premium_image_models_budget: surcharge bucket for premium image models (gpt_image_2, imagen4, nano_banana_pro, etc.). When this is 0 those premium models fail at the backend.
- storage_budget: total storage in bytes for uploaded assets.

Each bucket reports remaining, used, total, percent_used, and an optional note when something is worth surfacing (e.g. >90% used, or premium exhausted).

SCOPE: balance is per-token, not per-user. The same user can hold multiple tokens, each bound to a different subscription with different quotas.

THE LEGACY 'credits' FIELD IS NOT EXPOSED HERE ON PURPOSE. Followr's underlying API has a deprecated 'credits' counter that mixed AppSumo lifetime credits and topups, but it is NOT the operational budget for AI generation. Reading it leads to false negatives ("you have 221 credits, that's not enough for Veo at 400") when the user actually has thousands of images_allowed available. The four buckets above are the only correct way to reason about budget. If a user explicitly asks about the legacy field, explain it's a deprecated AppSumo/topup counter unrelated to plan budget and direct them to the buckets above.

THE BACKEND allows going OVER nominal quotas in many cases (Enterprise especially). Buckets are soft caps for visibility, not always hard blocks. Do not assume used > total === blocked.

WHICH MODELS ARE AVAILABLE ON THIS PLAN? There is NO Followr API endpoint that lists models available to the user. The model selector in the Followr UI is filtered client-side. From the API alone, attempting a model is the only way to know:
- Image/video: backend returns HTTP 402 with { entity: "premium_images" } when blocked. Surfaced as reason "plan_does_not_include_feature".
- Text: backend returns generic HTTP 422 "The selected model is invalid." that is indistinguishable from "model id does not exist". Surfaced as "model_or_driver_not_available".

KNOWN-SAFE DEFAULTS available on most plans (Free included):
- Text: gpt-4.1-mini
- Image: nano_banana_2
- Audio: elevenlabs_tts_3
- Video: Wan 2

WHEN TO WARN PROACTIVELY:
- Any bucket with percent_used > 0.9 -> warn before batch operations.
- ai_premium_image_models_budget.remaining === 0 AND the user wants a premium image model -> warn upfront (it will fail with 402) and suggest a non-premium alternative.

ALIAS: 'get_credits_balance' was the previous name and is still registered for backward compatibility, but new sessions should call 'get_ai_budget'.`,
      inputSchema: {},
    },
    aiBudgetHandler(client),
  );

  // Backward-compatible alias. Old sessions / cached tool catalogs may still
  // call 'get_credits_balance'; route it to the same handler. The new name
  // 'get_ai_budget' is clearer and aligns with the per-modality model that
  // Followr actually uses.
  server.registerTool(
    "get_credits_balance",
    {
      annotations: READ_ONLY,
      title: "[DEPRECATED ALIAS for get_ai_budget] Get the AI generation budget",
      description: `DEPRECATED ALIAS. Use get_ai_budget instead. This name remains for back-compat with sessions started before the rename. Behaviour is identical to get_ai_budget: returns four per-modality budgets (text, image+video, premium image models, storage) and intentionally omits the legacy 'credits' field that previously caused false-negative budget decisions.`,
      inputSchema: {},
    },
    aiBudgetHandler(client),
  );
}

// Shared handler. Wraps the raw SubscriptionBalance into four per-modality
// budget objects and DROPS the deprecated 'credits' field plus any sensitive
// payment-method fields. Intentionally NOT exposing the 'raw' response either:
// keeping it would re-introduce the same confusion (a model that sees a 'raw'
// object with a 'credits' field in it would still latch onto that number).
function aiBudgetHandler(client: FollowrClient) {
  return async () => {
    const balance = await client.getSubscriptionBalance();
    const bytesSpent =
      typeof balance.bytes_spent === "string" ? Number(balance.bytes_spent) : Number(balance.bytes_spent ?? 0);

    const textRemaining = balance.words_allowed - balance.words_spent;
    const imagesAndVideoRemaining = balance.images_allowed - balance.images_spent;
    const premiumRemaining = balance.premium_images_allowed - balance.premium_images_spent;
    const bytesRemaining = balance.bytes_allowed - bytesSpent;

    const textPct = balance.words_allowed > 0 ? balance.words_spent / balance.words_allowed : 0;
    const imagesPct = balance.images_allowed > 0 ? balance.images_spent / balance.images_allowed : 0;
    const premiumPct =
      balance.premium_images_allowed > 0 ? balance.premium_images_spent / balance.premium_images_allowed : 0;
    const storagePct = balance.bytes_allowed > 0 ? bytesSpent / balance.bytes_allowed : 0;

    const noteHigh = (pct: number) => (pct > 0.9 ? "over 90% used: warn the user before any batch operation" : null);

    const wrapped = {
      summary: `Text: ${balance.words_spent}/${balance.words_allowed}. Image+Video (shared bucket): ${balance.images_spent}/${balance.images_allowed}. Premium image models: ${balance.premium_images_spent}/${balance.premium_images_allowed}. Storage: ${(bytesSpent / 1e9).toFixed(2)}GB / ${(balance.bytes_allowed / 1e9).toFixed(2)}GB.`,
      ai_text_budget: {
        remaining: textRemaining,
        used: balance.words_spent,
        total: balance.words_allowed,
        percent_used: Number(textPct.toFixed(3)),
        note: noteHigh(textPct),
      },
      ai_image_and_video_budget: {
        remaining: imagesAndVideoRemaining,
        used: balance.images_spent,
        total: balance.images_allowed,
        percent_used: Number(imagesPct.toFixed(3)),
        note: noteHigh(imagesPct) ?? "video and image generation share this bucket; there is no separate video quota",
      },
      ai_premium_image_models_budget: {
        remaining: premiumRemaining,
        used: balance.premium_images_spent,
        total: balance.premium_images_allowed,
        percent_used: Number(premiumPct.toFixed(3)),
        note:
          premiumRemaining <= 0
            ? "exhausted: premium image models (gpt_image_2, imagen4, nano_banana_pro, etc.) will fail with HTTP 402 on this plan"
            : noteHigh(premiumPct),
      },
      storage_budget: {
        remaining_gb: Number((bytesRemaining / 1e9).toFixed(2)),
        used_gb: Number((bytesSpent / 1e9).toFixed(2)),
        total_gb: Number((balance.bytes_allowed / 1e9).toFixed(2)),
        percent_used: Number(storagePct.toFixed(3)),
        note: noteHigh(storagePct),
      },
      plan_features: {
        plus_chat_enabled: balance.plus_chat_enabled ?? null,
        white_label_enabled: balance.white_label_enabled ?? null,
      },
      _what_to_use_for_decisions:
        "For any video or image generation cost decision, read ai_image_and_video_budget.remaining. For text, read ai_text_budget.remaining. The deprecated 'credits' field from the raw API response is intentionally NOT included; it mixed AppSumo lifetime credits and topups and led to false-negative budget conclusions.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(wrapped, null, 2) }] };
  };
}
