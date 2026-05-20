// Driver resolution helper.
//
// Followr's /api/aiResults/* endpoints accept (driver, model) tuples that
// route the generation through the right backend provider (fal, openai,
// claude, etc.). When `driver` is omitted, the backend tries to infer it
// from `model`, but for certain models (notably nano_banana_2 and the Veo /
// Wan / SeeDance / Hailuo / Imagen sets) the inference is unreliable and
// the call fails with HTTP 422 "selected model is invalid" before reaching
// the actual generator.
//
// This helper centralizes the driver resolution so both ai-results.ts
// (generate_image, generate_ai_video_clip) and content-plan.ts (the
// execute_content_plan asset resolver) call the backend with consistent
// driver/model pairs.
//
// Background bug: prior to this helper, the execute_content_plan asset
// resolver passed only `model` to client.generateImage / generateAiVideoClip
// and the backend rejected the request. The standalone generate_image tool
// had its own driver inference logic for nano_banana_2 (special-cased to
// "fal"), which is why generate_image worked end-to-end but
// execute_content_plan did not. Verified empirically 2026-05-20.
//
// Resolution precedence (first non-empty wins):
//   1. Explicit driver from the tool input.
//   2. Company ai_preferences.{modality}_driver.
//   3. MODEL_DRIVER_HINTS[model] (catalog-driven inference).
//   4. undefined (let the backend infer).

import type { AiPreferences } from "@followr-mcp/shared";

/**
 * Known model_id to driver mappings. Encodes every image and video model
 * in content-plan-catalog.ts. All listed models are proxied through fal.ai
 * for Followr's account.
 *
 * Exceptions (omitted on purpose so the backend can infer):
 *   - gpt_image_2: probably "openai" but not empirically confirmed.
 *
 * If you add a model to the catalog, add it here too.
 */
export const MODEL_DRIVER_HINTS: Record<string, string> = {
  // Image models
  nano_banana_2: "fal",
  nano_banana_pro: "fal",
  imagen4_preview: "fal",
  imagen4_preview_fast: "fal",
  ideogram_v3: "fal",
  flux_pro_1_1: "fal",
  z_image_turbo: "fal",
  // gpt_image_2: deliberately omitted, let backend infer (probably "openai")

  // Video models
  veo_3_1_fast: "fal",
  veo_3_fast: "fal",
  veo_3_1: "fal",
  veo_3: "fal",
  wan_2: "fal",
  seedance_1_1_light: "fal",
  seedance_1_1_pro: "fal",
  seedance_2_0_fast: "fal",
  seedance_2_0: "fal",
  hailuo_0_2_standard: "fal",
  hailuo_0_2_premium: "fal",
};

export type Modality = "image" | "video" | "text" | "audio";

export interface ResolveDriverInput {
  /** Explicit driver from the tool input (highest precedence). */
  explicitDriver?: string;
  /** AI preferences from the company. */
  prefs?: AiPreferences;
  /** Modality. Determines which preference field to read. */
  modality: Modality;
  /** The model id being used. Used for the last-resort inference. */
  model?: string;
}

function getPrefDriver(
  prefs: AiPreferences | undefined,
  modality: Modality,
): string | undefined {
  if (!prefs) return undefined;
  switch (modality) {
    case "image":
      return prefs.image_driver;
    case "video":
      return prefs.video_driver;
    case "text":
      return prefs.text_driver;
    case "audio":
      // AiPreferences does not expose audio_driver yet. If Followr adds it
      // later, extend the AiPreferences shape and read it here.
      return undefined;
  }
}

/**
 * Resolves the driver to send to /api/aiResults/* given caller input,
 * company AI preferences, and the model id. Returns undefined when the
 * backend should infer.
 */
export function resolveDriver(input: ResolveDriverInput): string | undefined {
  if (input.explicitDriver && input.explicitDriver.length > 0) {
    return input.explicitDriver;
  }
  const prefDriver = getPrefDriver(input.prefs, input.modality);
  if (prefDriver && prefDriver.length > 0) {
    return prefDriver;
  }
  if (input.model) {
    const hint = MODEL_DRIVER_HINTS[input.model];
    if (hint) return hint;
  }
  return undefined;
}
