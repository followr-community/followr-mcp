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
    "get_credits_balance",
    {
      annotations: READ_ONLY,
      title: "Get the current credit and quota balance for the API token",
      description: `Return the subscription balance bound to the current API token: per-modality quotas (words, images, premium_images, bytes), plan features (whitelabel, plus_chat, getlead, api_keys), renewal timestamp.

SCOPE: balance is per-token, not per-user. The same user can hold multiple tokens, each bound to a different subscription with different quotas. Verified empirically.

QUOTA SEMANTICS (verified empirically 2026-05-19):

The 'credits' field is a generic counter and does NOT represent the total budget. Followr uses MULTIPLE SEPARATE QUOTAS:
- words_spent / words_allowed: text generation budget (gpt-4.1-mini, Claude, DeepSeek, etc.). Each model has a per-call cost in "word credits" (1 for gpt-4.1-mini, 10 for Claude 4.5 Sonnet, 20 for Claude 4 Opus, etc.).
- images_spent / images_allowed: image AND video generation budget (yes, video also tires against images_allowed, not a separate video quota). Per-call cost varies from 2 (Z-Image Turbo) to 1000 (Google Veo 3).
- premium_images_spent / premium_images_allowed: premium-model surcharge bucket. Some image models (GPT Image 2, Imagen 4, etc.) consume premium_images on top of images. When premium_images_allowed === 0, those models are blocked at the backend.
- bytes_spent / bytes_allowed: total storage.

The backend allows going OVER nominal quotas in many cases (Enterprise especially). Quotas are soft caps for billing/visibility, not always hard blocks. Do not assume spent > allowed === blocked.

WHICH MODELS ARE AVAILABLE ON THIS PLAN? There is NO Followr API endpoint that lists the models available to the user. The model selector in the Followr UI is hardcoded in the SPA's JS bundle and filtered client-side using the balance fields above. From the API alone, the only way to discover which models are allowed is by attempting them:
- For image/video models: backend returns HTTP 402 with body { entity: "premium_images", message: "..." } when blocked. Caught by toolErrorFromException and surfaced as reason: "plan_does_not_include_feature".
- For text models: backend returns generic HTTP 422 { "message": "The selected model is invalid." } that is INDISTINGUISHABLE from "model id does not exist". Caught and surfaced as reason: "model_or_driver_not_available".

KNOWN-SAFE DEFAULTS (available on most plans including Free):
- Text: gpt-4.1-mini (driver: openai)
- Image: nano_banana_2 (driver: fal)
- Audio: elevenlabs_tts_3 (driver: fal)
- Video: Wan 2 (driver: fal)

If the user asks "what models are available to me", call this tool, then say: "Words quota: X/Y, Images quota: X/Y, Premium images quota: X/Y. The Followr API does not list per-plan models. I can try any model you ask for and let you know if your plan does not include it. Safe defaults that almost always work are gpt-4.1-mini for text, nano_banana_2 for image, Wan 2 for video. The full list with locks is in the model selector in the Followr UI."

WHEN TO WARN PROACTIVELY:
- A quota_spent / quota_allowed > 0.9 → warn before batch operations.
- premium_images_allowed === 0 AND user asks for a premium image model → warn upfront (it will fail with 402) and suggest alternative.`,
      inputSchema: {},
    },
    async () => {
      const balance = await client.getSubscriptionBalance();
      return { content: [{ type: "text", text: JSON.stringify(balance, null, 2) }] };
    },
  );
}
