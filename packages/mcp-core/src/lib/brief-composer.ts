// Brief composer: builds the natural-language brief that the executor feeds
// to Creative Studio (image / video) when a sub_post is Tier 1 (concept_only
// or explicit_brief mode).
//
// Design: Creative Studio already enriches whatever it receives in `prompt`
// with the 1850-char brand design system + style_key + logo + colors. So the
// composer's job is NOT to write a Midjourney-style prompt; it is to write a
// clear, structured BRIEF describing what the post is about, what format it
// targets, and any agent-extracted art direction hint. Creative Studio takes
// it from there.
//
// References (Tier 3 behavior we are matching from a higher-level input):
//   - generate_brand_creative's prompt is described as "topic, intent,
//     audience" e.g. "Cover slide for a B2B SaaS post about productivity
//     tips for founders". That is the shape we mimic.
//   - Carousels: we tell CS the total slot count and which slot we are
//     generating so the narrative arc is preserved (cover, steps, CTA).
//
// PATH C (literal_prompt mode) does NOT use this composer. The agent already
// provided the verbatim prompt and the executor forwards it as-is to
// /api/aiResults/image (bypass Creative Studio entirely).
//
// Added 2026-05-27 / v0.6.1.

import type {
  AssetLayout,
  AssetSourceConceptImage,
  AssetSourceConceptVideo,
  PlanItem,
  ProductType,
  SocialNetwork,
  SubPost,
} from "./content-plan-state.js";

interface NetworkLabelMap {
  network_display: string;
  format_display: string;
}

function describeNetwork(network: SocialNetwork): string {
  const map: Record<SocialNetwork, string> = {
    instagram: "Instagram",
    tiktok: "TikTok",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    x: "X / Twitter",
    pinterest: "Pinterest",
    threads: "Threads",
    youtube: "YouTube",
    bluesky: "Bluesky",
  };
  return map[network];
}

function describeFormat(product_type: ProductType, layout: AssetLayout): string {
  if (product_type === "reel") return "Reel (9:16 vertical short)";
  if (product_type === "short") return "Short (9:16 vertical short)";
  if (product_type === "story") return "Story (9:16 vertical, ephemeral)";
  if (product_type === "long_video") return "Long-form video (16:9 horizontal)";
  // feed
  if (layout === "single_image") return "Feed single image";
  if (layout === "carousel_images") return "Feed carousel";
  if (layout === "single_video") return "Feed video";
  if (layout === "carousel_mixed") return "Feed mixed-media carousel";
  if (layout === "single_gif") return "Feed GIF";
  return product_type;
}

function networkLabels(sp: SubPost): NetworkLabelMap {
  return {
    network_display: describeNetwork(sp.social_network),
    format_display: describeFormat(sp.product_type, sp.asset_layout),
  };
}

export interface ImageBriefArgs {
  plan_item: PlanItem;
  sub_post: SubPost;
  spec: AssetSourceConceptImage;
}

/**
 * Compose a Creative Studio brief for a single AI image OR for one slide of a
 * carousel. Carousels call this once per slot with the matching slot_index /
 * slot_count, so each slot's brief mentions where it sits in the narrative
 * arc (cover, mid, CTA, etc.).
 *
 * Output target: 200-500 chars (well within Creative Studio's 2000 char cap,
 * leaving headroom for the design system enrichment to dominate the final
 * generation prompt as intended).
 */
export function composeImageBrief(args: ImageBriefArgs): string {
  const { plan_item, sub_post, spec } = args;
  const { network_display, format_display } = networkLabels(sub_post);
  const parts: string[] = [];

  // Day-level intent. concept_shared is the umbrella that tells CS what the
  // post communicates, before per-network framing.
  parts.push(`Day's concept: ${plan_item.concept_shared}.`);

  // Sub_post-level intent. caption_concept is the editorial brief: hook,
  // key points, tone hints, CTA. It is the agent's reasoning trace and the
  // most informative single field for prompt synthesis.
  if (sub_post.caption_concept) {
    parts.push(`Post brief: ${sub_post.caption_concept}.`);
  }

  // Format hint. CS uses aspect_ratio separately so we mention it for context
  // (helps when the same brief is reused at different aspect ratios across
  // networks).
  parts.push(`Target: ${network_display} ${format_display} (aspect ${spec.aspect_ratio ?? "1:1"}).`);

  // Carousel slot positioning. Helps CS keep narrative continuity across
  // slides without us having to spell out per-slide prompts.
  if (spec.slot_count > 1) {
    const slot = spec.slot_index + 1;
    const total = spec.slot_count;
    let role: string;
    if (slot === 1) role = "Cover slide (hook + headline)";
    else if (slot === total) role = "Closing slide (call to action)";
    else role = `Body slide ${slot} of ${total} (advances the narrative arc between cover and CTA)`;
    parts.push(`Carousel position: ${role}. Stay visually consistent with the rest of the ${total}-slide carousel.`);
  }

  // Path B: art direction hint. Additive on top of the brand-aligned design
  // system, NOT a replacement. CS's enrichment still applies.
  if (spec.mode === "explicit_brief" && spec.art_direction_hint) {
    parts.push(`Additional creative direction: ${spec.art_direction_hint}.`);
  }

  return parts.join(" ");
}

export interface VideoBriefArgs {
  plan_item: PlanItem;
  sub_post: SubPost;
  spec: AssetSourceConceptVideo;
}

/**
 * Compose a brief for an AI video clip (text-to-video or image-to-video). The
 * model treats this as a single-scene prompt; the agent should NOT use this
 * for narratives with multiple cuts, that is what avatar_multi_scene is for
 * (and avatar scripts are verbatim, never composed by this helper).
 */
export function composeVideoBrief(args: VideoBriefArgs): string {
  const { plan_item, sub_post, spec } = args;
  const { network_display, format_display } = networkLabels(sub_post);
  const parts: string[] = [];

  parts.push(`Day's concept: ${plan_item.concept_shared}.`);
  if (sub_post.caption_concept) {
    parts.push(`Video brief: ${sub_post.caption_concept}.`);
  }
  parts.push(`Target: ${network_display} ${format_display} (aspect ${spec.aspect_ratio ?? "9:16"}, ${spec.duration_seconds ?? 8}s).`);
  parts.push(
    "Single continuous scene with no cuts. If the brief implies multiple shots, prioritize the single most expressive moment and keep the framing coherent end to end.",
  );

  if (spec.mode === "explicit_brief" && spec.art_direction_hint) {
    parts.push(`Additional creative direction: ${spec.art_direction_hint}.`);
  }

  return parts.join(" ");
}

/**
 * Pre-flight checker the validator (or update_content_plan) uses to detect
 * when a Tier 1 literal_prompt looks suspiciously low-effort (would have been
 * better as art_direction_hint with Creative Studio enrichment). Returns a
 * soft warning string when the heuristic fires, null otherwise.
 *
 * Heuristic (deliberately conservative):
 *   - Bypass to AI Images path SHOULD be reserved for cases where the user
 *     gave technical / pixel-level direction. Signals: lens, F-stop, film
 *     stock, anamorphic, dolly zoom, shutter speed, specific film emulation,
 *     explicit "no brand" wording.
 *   - When the literal_prompt is < 200 chars AND has none of those signals,
 *     it usually means the agent should have used art_direction_hint
 *     instead. Surface a soft warning so the agent can self-correct on the
 *     next update_content_plan.
 *
 * Threshold tightened from <200 to <300 per Marcos's 2026-05-27 call.
 */
const TECHNICAL_DIRECTION_PATTERNS: RegExp[] = [
  /\b\d{2,3}\s?mm\b/i, // 85mm, 35mm
  /\bf[/.]?\d/i, // F1.4, F/2.8
  /\bISO\s?\d+\b/i,
  /\banamorphic\b/i,
  /\bdolly\s?zoom\b/i,
  /\bshutter\s?(speed|angle)\b/i,
  /\bKodak\b|\bFuji(film)?\b|\bPortra\b|\bVelvia\b|\bCineStill\b/i,
  /\bArri\b|\bRED\b|\bBlackmagic\b|\bSony\s?(FX|A7|Venice)\b/i,
  /\bIMAX\b|\bRAW\b|\bProRes\b|\b(8K|6K|4K)\b/i,
  /\bbokeh\b|\bdepth\s?of\s?field\b/i,
  /\bsin\s?marca\b|\bno\s?brand\b|\bexperimental\b|\bstock[-\s]?like\b/i,
];

function looksTechnical(prompt: string): boolean {
  for (const re of TECHNICAL_DIRECTION_PATTERNS) {
    if (re.test(prompt)) return true;
  }
  return false;
}

/**
 * Degraded brief composer used when the executor cannot resolve the parent
 * plan_item / sub_post (very rare; can happen if a Tier 1 spec is processed
 * outside the standard execute path, e.g. from a preview tool that lost the
 * context bridge). The result is plain but functional: just enough info from
 * the spec itself for Creative Studio to produce something on-brand.
 */
export function composeImageBriefFromSpecOnly(spec: AssetSourceConceptImage): string {
  const parts: string[] = [];
  parts.push("Generic on-brand visual for this company.");
  parts.push(`Aspect ${spec.aspect_ratio ?? "1:1"}.`);
  if (spec.slot_count > 1) {
    parts.push(`Carousel slot ${spec.slot_index + 1} of ${spec.slot_count}.`);
  }
  if (spec.mode === "explicit_brief" && spec.art_direction_hint) {
    parts.push(`Creative direction: ${spec.art_direction_hint}.`);
  }
  return parts.join(" ");
}

export function composeVideoBriefFromSpecOnly(spec: AssetSourceConceptVideo): string {
  const parts: string[] = [];
  parts.push("Generic on-brand short video for this company.");
  parts.push(`Aspect ${spec.aspect_ratio ?? "9:16"}, ${spec.duration_seconds ?? 8}s, single continuous scene.`);
  if (spec.mode === "explicit_brief" && spec.art_direction_hint) {
    parts.push(`Creative direction: ${spec.art_direction_hint}.`);
  }
  return parts.join(" ");
}

export function detectMisroutedLiteralPrompt(spec: {
  mode: AssetSourceConceptImage["mode"] | AssetSourceConceptVideo["mode"];
  literal_prompt?: string;
  model?: string;
}): string | null {
  if (spec.mode !== "literal_prompt") return null;
  const p = spec.literal_prompt ?? "";
  if (p.length === 0) return null;
  // Heuristic threshold: anything <300 chars AND not technical is probably
  // misrouted (should be art_direction_hint instead).
  if (p.length >= 300) return null;
  if (looksTechnical(p)) return null;
  // CS-compatible model: also bias toward warning, since they would have
  // benefited from CS enrichment.
  const csSupported =
    spec.model === undefined ||
    spec.model === "nano_banana_2" ||
    spec.model === "nano_banana_pro";
  if (!csSupported) return null;
  return (
    "Este item está en Path C (bypass Creative Studio con literal_prompt) pero el contenido " +
    "no parece pixel-level (sin specs técnicos de cámara/lente/film y bajo 300 chars). " +
    "Probable misrouting: considerá moverlo a override.art_direction_hint para conservar " +
    "el brand enrichment de Creative Studio."
  );
}
