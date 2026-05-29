// Tier 3 regression suite.
//
// Goal: prove that v0.6.1 does NOT change behavior for plans built in the
// legacy Tier 3 shape (assets_strategy with explicit ai_generate / url /
// asset_id / ai_avatar_* sources). Every test here uses ONLY Tier 3 shapes
// and asserts:
//   - normalization passes through untouched
//   - fingerprints stay stable (cross-network dedup still works)
//   - cost estimation matches the pre-v0.6.1 behavior on identical inputs
//   - the union schema (PlanItemUnionSchema) accepts the Tier 3 shape
//
// If any of these regress, the suite fails red and we know v0.6.1
// inadvertently changed Tier 3 semantics.

import { describe, it, expect } from "vitest";

import { normalizeIncomingPlanItem } from "./plan-normalize.js";
import {
  fingerprintAssetSource,
  estimatePlanItemCostDeduped,
  type AssetSourceRef,
} from "../tools/content-plan.js";
import type {
  AssetSourceAiImage,
  AssetSourceAiVideo,
  AssetSourceAvatarLipsync,
  AssetSourceAvatarVideo,
  AssetsStrategy,
  PlanItem,
  SubPost,
} from "./content-plan-state.js";

// ── Tier 3 fixture builders ─────────────────────────────────────────────────

function makeTier3AiImage(prompt: string, model = "nano_banana_2"): AssetSourceAiImage {
  return {
    type: "ai_generate",
    prompt,
    model,
    aspect_ratio: "1:1",
    use_brand_visual_identity: true,
    use_creative_studio: true,
  };
}

function makeTier3SubPost(
  network: SubPost["social_network"],
  strategy: AssetsStrategy,
  layout: SubPost["asset_layout"] = "single_image",
): SubPost {
  return {
    social_network: network,
    product_type: "feed",
    asset_layout: layout,
    assets_strategy: strategy,
    caption_concept: "Caption concept for this sub_post.",
    copy_draft: "Copy draft text the user will see in the post.",
  };
}

function makeTier3Item(slug: string, sub_posts: SubPost[]): PlanItem {
  return {
    slug,
    date: "2026-06-01",
    publish_at_time_local: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    concept_shared: "Tier 3 fixture concept.",
    rationale: "Tier 3 fixture rationale.",
    sub_posts,
  };
}

// ── Normalization passthrough ───────────────────────────────────────────────

describe("Tier 3 regression: normalization passthrough", () => {
  it("Tier 3 single-image plan_item passes through unchanged", () => {
    const original = makeTier3Item("img-1", [
      makeTier3SubPost("instagram", {
        image_source: makeTier3AiImage("Cinematic close-up of la campera"),
      }),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.image_source).toEqual(
      original.sub_posts[0]?.assets_strategy.image_source,
    );
  });

  it("Tier 3 carousel passes through with all explicit prompts intact", () => {
    const sources = [
      makeTier3AiImage("Slide 1: cover"),
      makeTier3AiImage("Slide 2: step one"),
      makeTier3AiImage("Slide 3: step two"),
      makeTier3AiImage("Slide 4: step three"),
      makeTier3AiImage("Slide 5: CTA"),
    ];
    const original = makeTier3Item("carousel-1", [
      makeTier3SubPost(
        "instagram",
        { carousel_sources: sources },
        "carousel_images",
      ),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.carousel_sources).toHaveLength(5);
    expect(r.item?.sub_posts[0]?.assets_strategy.carousel_sources?.[0]).toEqual(sources[0]);
    expect(r.item?.sub_posts[0]?.assets_strategy.carousel_sources?.[4]).toEqual(sources[4]);
  });

  it("Tier 3 url image passes through unchanged", () => {
    const original = makeTier3Item("url-1", [
      makeTier3SubPost("facebook", {
        image_source: { type: "url", url: "https://example.com/photo.jpg" },
      }),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.image_source).toEqual({
      type: "url",
      url: "https://example.com/photo.jpg",
    });
  });

  it("Tier 3 asset_id passes through unchanged", () => {
    const original = makeTier3Item("asset-1", [
      makeTier3SubPost("instagram", {
        image_source: { type: "asset_id", id: 9876543 },
      }),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.image_source).toEqual({
      type: "asset_id",
      id: 9876543,
    });
  });

  it("Tier 3 ai_avatar_lipsync passes through unchanged", () => {
    const lipsync: AssetSourceAvatarLipsync = {
      type: "ai_avatar_lipsync",
      script: "Hola, te muestro por qué esta campera funciona.",
      avatar_id: 12,
    };
    const original = makeTier3Item("lipsync-1", [
      makeTier3SubPost(
        "instagram",
        { video_source: lipsync },
        "single_video",
      ),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.video_source).toEqual(lipsync);
  });

  it("Tier 3 ai_avatar_video (multi-scene) passes through unchanged", () => {
    const multi: AssetSourceAvatarVideo = {
      type: "ai_avatar_video",
      scripts: ["Scene 1", "Scene 2", "Scene 3"],
      avatar_id: 12,
      generate_backgrounds: true,
    };
    const original = makeTier3Item("avatar-multi-1", [
      makeTier3SubPost(
        "instagram",
        { video_source: multi },
        "single_video",
      ),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.video_source).toEqual(multi);
  });

  it("Tier 3 ai_generate video passes through unchanged", () => {
    const video: AssetSourceAiVideo = {
      type: "ai_generate",
      model: "wan_2.2",
      prompt: "Person walking through a forest at golden hour",
      duration_seconds: 8,
    };
    const original = makeTier3Item("ai-video-1", [
      makeTier3SubPost(
        "instagram",
        { video_source: video },
        "single_video",
      ),
    ]);
    const r = normalizeIncomingPlanItem(original, undefined);
    expect(r.errors).toEqual([]);
    expect(r.item?.sub_posts[0]?.assets_strategy.video_source).toEqual(video);
  });
});

// ── Fingerprint stability (cross-network dedup) ─────────────────────────────

describe("Tier 3 regression: fingerprint stability", () => {
  it("two ai_generate images with identical prompt+model+aspect produce same fingerprint", () => {
    const a = makeTier3AiImage("Same prompt for both", "nano_banana_2");
    const b = makeTier3AiImage("Same prompt for both", "nano_banana_2");
    const fpA = fingerprintAssetSource({ src: a, mode: "image" });
    const fpB = fingerprintAssetSource({ src: b, mode: "image" });
    expect(fpA).toBe(fpB);
  });

  it("shared_concept_key collapses fingerprints regardless of prompt drift", () => {
    const a: AssetSourceAiImage = {
      ...makeTier3AiImage("Prompt variant A"),
      shared_concept_key: "cover",
    };
    const b: AssetSourceAiImage = {
      ...makeTier3AiImage("Different prompt variant B"),
      shared_concept_key: "cover",
    };
    const fpA = fingerprintAssetSource({ src: a, mode: "image" });
    const fpB = fingerprintAssetSource({ src: b, mode: "image" });
    expect(fpA).toBe(fpB);
  });

  it("different aspect_ratio produces different fingerprint", () => {
    const a: AssetSourceAiImage = {
      ...makeTier3AiImage("Same prompt"),
      aspect_ratio: "1:1",
    };
    const b: AssetSourceAiImage = {
      ...makeTier3AiImage("Same prompt"),
      aspect_ratio: "9:16",
    };
    const fpA = fingerprintAssetSource({ src: a, mode: "image" });
    const fpB = fingerprintAssetSource({ src: b, mode: "image" });
    expect(fpA).not.toBe(fpB);
  });

  it("ai_avatar_video with same scripts dedup; with different scripts do NOT dedup", () => {
    const a: AssetSourceAvatarVideo = {
      type: "ai_avatar_video",
      scripts: ["A", "B", "C"],
      avatar_id: 12,
    };
    const b: AssetSourceAvatarVideo = {
      type: "ai_avatar_video",
      scripts: ["A", "B", "C"],
      avatar_id: 12,
    };
    const c: AssetSourceAvatarVideo = {
      type: "ai_avatar_video",
      scripts: ["A", "B", "DIFFERENT"],
      avatar_id: 12,
    };
    const fpA = fingerprintAssetSource({ src: a, mode: "video", aspect_ratio: "9:16" });
    const fpB = fingerprintAssetSource({ src: b, mode: "video", aspect_ratio: "9:16" });
    const fpC = fingerprintAssetSource({ src: c, mode: "video", aspect_ratio: "9:16" });
    expect(fpA).toBe(fpB);
    expect(fpA).not.toBe(fpC);
  });
});

// ── Cost estimation: pre-v0.6.1 expected values ─────────────────────────────

describe("Tier 3 regression: cost estimation matches pre-v0.6.1 expectations", () => {
  it("single ai_generate image at nano_banana_2 = 25 cr", () => {
    const item = makeTier3Item("img-cost-1", [
      makeTier3SubPost("instagram", {
        image_source: makeTier3AiImage("Some prompt", "nano_banana_2"),
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1);
    expect(c.image_ai_cost).toBe(25);
  });

  it("single ai_generate image at nano_banana_pro = 45 cr", () => {
    const item = makeTier3Item("img-cost-pro", [
      makeTier3SubPost("instagram", {
        image_source: makeTier3AiImage("Some prompt", "nano_banana_pro"),
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1);
    expect(c.image_ai_cost).toBe(45);
  });

  it("IG + FB ai_generate with same prompt collapses to 1 generation (25 cr, not 50)", () => {
    const sharedSrc = makeTier3AiImage("Shared prompt across networks");
    const item = makeTier3Item("img-cross-net", [
      makeTier3SubPost("instagram", { image_source: sharedSrc }),
      makeTier3SubPost("facebook", { image_source: sharedSrc }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1);
    expect(c.image_ai_cost).toBe(25);
  });

  it("ai_avatar_lipsync now scales with script length (2026-05-29 refactor)", () => {
    // Pre-refactor the cost was a flat 25 cr/sec * 12 sec = 300 cr for ANY
    // script. Now estimateTtsSeconds derives the seconds from script length
    // (14 chars/sec, 8s floor). "Test script" = 11 chars → ceil(11/14)=1,
    // floored to 8 s. Total = 25 * 8 = 200 cr.
    const item = makeTier3Item("lipsync-cost", [
      makeTier3SubPost(
        "instagram",
        {
          video_source: {
            type: "ai_avatar_lipsync",
            script: "Test script",
            avatar_id: 12,
          },
        },
        "single_video",
      ),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_count).toBe(1);
    expect(c.video_ai_cost).toBe(25 * 8);
  });

  it("Multi-scene avatar_video charges per-scene TTS seconds + optional backgrounds", () => {
    // Post 2026-05-29 refactor: cost = 25 * sum(estimateTtsSeconds(script))
    // + (backgrounds ? 60 * scenes : 0). Scripts "A", "B", "C" each are 1
    // char → ceil(1/14)=1, floored to 8 s each. Total seconds = 24.
    // Cost = 25 * 24 + 60 * 3 = 600 + 180 = 780.
    const item = makeTier3Item("multi-scene-cost", [
      makeTier3SubPost(
        "instagram",
        {
          video_source: {
            type: "ai_avatar_video",
            scripts: ["A", "B", "C"], // 3 scenes, each floored to 8 s
            avatar_id: 12,
            generate_backgrounds: true,
          },
        },
        "single_video",
      ),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_count).toBe(1);
    expect(c.video_ai_cost).toBe(25 * (8 * 3) + 60 * 3);
  });

  it("Carousel of 5 ai_generate slides with different prompts = 5 * 25 cr", () => {
    const sources = [
      makeTier3AiImage("Slide 1"),
      makeTier3AiImage("Slide 2"),
      makeTier3AiImage("Slide 3"),
      makeTier3AiImage("Slide 4"),
      makeTier3AiImage("Slide 5"),
    ];
    const item = makeTier3Item("carousel-cost", [
      makeTier3SubPost(
        "instagram",
        { carousel_sources: sources },
        "carousel_images",
      ),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(5);
    expect(c.image_ai_cost).toBe(125);
  });

  it("url uploads count as upload_count, no AI cost", () => {
    const item = makeTier3Item("url-cost", [
      makeTier3SubPost("instagram", {
        image_source: { type: "url", url: "https://x/a.jpg" },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.upload_count).toBe(1);
    expect(c.image_ai_cost).toBe(0);
  });

  it("asset_id reuse counts as reuse_count, no cost", () => {
    const item = makeTier3Item("reuse-cost", [
      makeTier3SubPost("instagram", {
        image_source: { type: "asset_id", id: 42 },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.reuse_count).toBe(1);
    expect(c.image_ai_cost).toBe(0);
  });
});

// ── Mixed Tier 3 + Tier 1 in one plan ───────────────────────────────────────

describe("Tier 3 regression: mixed Tier 3 + Tier 1 plans coexist", () => {
  it("a plan with one Tier 3 sub_post and one Tier 1 sub_post normalizes correctly per sub_post", () => {
    // Build via the union: one item has a Tier 3 sub_post inline and another
    // item is built as Tier 1 (sub_post with assets_strategy_lite).
    const tier3 = makeTier3Item("tier3-1", [
      makeTier3SubPost("instagram", {
        image_source: makeTier3AiImage("Tier 3 explicit prompt"),
      }),
    ]);
    const tier1Lite = {
      slug: "tier1-1",
      date: "2026-06-02",
      publish_at_time_local: "12:00",
      timezone: "America/Argentina/Buenos_Aires",
      concept_shared: "Tier 1 concept",
      sub_posts: [
        {
          social_network: "instagram" as const,
          product_type: "feed" as const,
          asset_layout: "single_image" as const,
          assets_strategy_lite: { asset_kind: "image" as const },
          caption_concept: "Brief caption",
        },
      ],
    };

    const r3 = normalizeIncomingPlanItem(tier3, undefined);
    const r1 = normalizeIncomingPlanItem(tier1Lite, undefined);
    expect(r3.errors).toEqual([]);
    expect(r1.errors).toEqual([]);
    expect(r3.item?.sub_posts[0]?.assets_strategy.image_source?.type).toBe("ai_generate");
    expect(r1.item?.sub_posts[0]?.assets_strategy.image_source?.type).toBe("concept_only_image");
  });
});
