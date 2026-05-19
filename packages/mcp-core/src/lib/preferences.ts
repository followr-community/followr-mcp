// AI preferences helper.
//
// Followr lets users configure default driver/model per modality (text, image,
// video) in Company Settings > AI. Those preferences live on the Company
// resource at `ai_preferences`. The /api/aiResults/* generation endpoints do
// NOT automatically apply those preferences when driver/model are omitted
// from the request body (verified empirically). Without compensating here,
// the MCP would silently override the user's UI configuration with hardcoded
// fallback defaults.
//
// Fix: fetch the company before each generation, read ai_preferences, and
// pass the configured driver/model. The tool call's explicit driver/model
// still wins (user override), then the company preference, then the hardcoded
// fallback as a last resort.
//
// Cost: one extra getCompany roundtrip per generation. Negligible vs the
// model latency (seconds to minutes for image/video). Fails-open: if
// getCompany errors, returns empty preferences and the hardcoded fallback
// kicks in.

import { FollowrClient } from "@followr-mcp/shared";
import type { AiPreferences } from "@followr-mcp/shared";

export async function getAiPreferences(
  client: FollowrClient,
  companyId: number,
): Promise<AiPreferences> {
  try {
    const company = await client.getCompany(companyId);
    return company.ai_preferences ?? {};
  } catch {
    return {};
  }
}
