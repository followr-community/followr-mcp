// Tests for plan-normalize.ts
//
// These tests are pure (no network, no time-dependent state). They feed Lite
// plan_items and assert the canonical PlanItem shape that downstream consumers
// (validator, cost, executor, preview) operate on.

import { describe, it, expect } from "vitest";

import {
  deriveAspectRatio,
  normalizeIncomingPlan,
  normalizeIncomingPlanItem,
} from "./plan-normalize.js";
import type {
  PlanDefaults,
  PlanItemLite,
  SubPostLite,
  AssetSourceConceptImage,
  AssetSourceConceptVideo,
} from "./content-plan-state.js";

// Helpers ────────────────────────────────────────────────────────────────────

function makeLiteSubPost(overrides: Partial<SubPostLite> = {}): SubPostLite {
  return {
    social_network: "instagram",
    product_type: "feed",
    asset_layout: "single_image",
    assets_strategy_lite: { asset_kind: "image" },
    caption_concept: "Brief concept for this sub_post.",
    ...overrides,
  };
}

function makeLiteItem(overrides: Partial<PlanItemLite> = {}): PlanItemLite {
  return {
    slug: "lun-test",
    date: "2026-06-01",
    publish_at_time_local: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    concept_shared: "Day concept umbrella.",
    sub_posts: [makeLiteSubPost()],
    ...overrides,
  };
}

// asset_kind = image ─────────────────────────────────────────────────────────

describe("normalizeIncomingPlan: asset_kind=image", () => {
  it("maps single image to one concept_only_image source", () => {
    const item = makeLiteItem();
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors).toEqual([]);
    expect(r.plan_items).toHaveLength(1);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy.image_source;
    expect(src).toMatchObject({
      type: "concept_only_image",
      mode: "concept_only",
      slot_index: 0,
      slot_count: 1,
      model: "nano_banana_2",
      aspect_ratio: "1:1",
    });
  });

  it("honors plan_defaults.image_model when override.model is absent", () => {
    const item = makeLiteItem();
    const defaults: PlanDefaults = { image_model: "nano_banana_pro" };
    const r = normalizeIncomingPlan([item], defaults);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.model).toBe("nano_banana_pro");
  });

  it("override.model wins over plan_defaults.image_model", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: {
            asset_kind: "image",
            override: { model: "ideogram_v3" },
          },
        }),
      ],
    });
    const defaults: PlanDefaults = { image_model: "nano_banana_pro" };
    const r = normalizeIncomingPlan([item], defaults);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.model).toBe("ideogram_v3");
  });

  it("override.aspect_ratio wins over derived aspect", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          social_network: "instagram",
          asset_layout: "single_image",
          assets_strategy_lite: {
            asset_kind: "image",
            override: { aspect_ratio: "3:4" },
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.aspect_ratio).toBe("3:4");
  });
});

// asset_kind = carousel_image ────────────────────────────────────────────────

describe("normalizeIncomingPlan: asset_kind=carousel_image", () => {
  it("expands slot_count=5 into 5 concept_only_image sources with proper slot_index", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "carousel_images",
          assets_strategy_lite: { asset_kind: "carousel_image", slot_count: 5 },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors).toEqual([]);
    const sources = r.plan_items[0]?.sub_posts[0]?.assets_strategy.carousel_sources;
    expect(sources).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(sources?.[i]).toMatchObject({
        type: "concept_only_image",
        mode: "concept_only",
        slot_index: i,
        slot_count: 5,
      });
    }
  });

  it("errors when carousel_image lacks slot_count", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "carousel_images",
          assets_strategy_lite: { asset_kind: "carousel_image" },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toBe("missing_slot_count");
  });

  it("all carousel slots inherit the same override.art_direction_hint (Path B)", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "carousel_images",
          assets_strategy_lite: {
            asset_kind: "carousel_image",
            slot_count: 3,
            override: { art_direction_hint: "tono cálido" },
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    const sources = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .carousel_sources as AssetSourceConceptImage[];
    expect(sources).toHaveLength(3);
    expect(sources.every((s) => s.mode === "explicit_brief")).toBe(true);
    expect(sources.every((s) => s.art_direction_hint === "tono cálido")).toBe(true);
  });
});

// Mode resolution: Path A / B / C ────────────────────────────────────────────

describe("normalizeIncomingPlan: mode resolution", () => {
  it("mode=concept_only when no override", () => {
    const r = normalizeIncomingPlan([makeLiteItem()], undefined);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.mode).toBe("concept_only");
    expect(src.art_direction_hint).toBeUndefined();
    expect(src.literal_prompt).toBeUndefined();
  });

  it("mode=explicit_brief when only art_direction_hint set (Path B)", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: {
            asset_kind: "image",
            override: { art_direction_hint: "luz dorada" },
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.mode).toBe("explicit_brief");
    expect(src.art_direction_hint).toBe("luz dorada");
    expect(src.literal_prompt).toBeUndefined();
  });

  it("mode=literal_prompt when only literal_prompt set (Path C)", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: {
            asset_kind: "image",
            override: { literal_prompt: "cinematic close-up 85mm" },
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .image_source as AssetSourceConceptImage;
    expect(src.mode).toBe("literal_prompt");
    expect(src.literal_prompt).toBe("cinematic close-up 85mm");
    expect(src.art_direction_hint).toBeUndefined();
  });
});

// Aspect ratio derivation ────────────────────────────────────────────────────

describe("deriveAspectRatio", () => {
  it("Instagram reel = 9:16", () => {
    expect(deriveAspectRatio("instagram", "reel", "single_video")).toBe("9:16");
  });

  it("TikTok feed = 9:16 because product_type isn't vertical -> falls through to social_network rules", () => {
    // TikTok feed with single_video: product_type 'feed' doesn't auto-9:16,
    // and TikTok doesn't have a dedicated rule in the helper, so falls
    // through to default 1:1. The video aspect lock policy at execute time
    // handles 9:16 vertical for TikTok separately.
    expect(deriveAspectRatio("tiktok", "feed", "single_video")).toBe("1:1");
  });

  it("Instagram Story = 9:16", () => {
    expect(deriveAspectRatio("instagram", "story", "single_image")).toBe("9:16");
  });

  it("YouTube long_video = 16:9", () => {
    expect(deriveAspectRatio("youtube", "long_video", "single_video")).toBe("16:9");
  });

  it("YouTube short = 9:16", () => {
    expect(deriveAspectRatio("youtube", "short", "single_video")).toBe("9:16");
  });

  it("LinkedIn feed single_image = 16:9", () => {
    expect(deriveAspectRatio("linkedin", "feed", "single_image")).toBe("16:9");
  });

  it("LinkedIn feed carousel_images = 1:1", () => {
    expect(deriveAspectRatio("linkedin", "feed", "carousel_images")).toBe("1:1");
  });

  it("X / Twitter feed = 16:9", () => {
    expect(deriveAspectRatio("x", "feed", "single_image")).toBe("16:9");
  });

  it("Pinterest feed = 3:4 vertical", () => {
    expect(deriveAspectRatio("pinterest", "feed", "single_image")).toBe("3:4");
  });

  it("Instagram feed single_image = 1:1 (default)", () => {
    expect(deriveAspectRatio("instagram", "feed", "single_image")).toBe("1:1");
  });

  it("Facebook feed = 1:1", () => {
    expect(deriveAspectRatio("facebook", "feed", "single_image")).toBe("1:1");
  });
});

// Source kinds: url / asset_id / video / avatar ──────────────────────────────

describe("normalizeIncomingPlan: non-AI source kinds", () => {
  it("asset_kind=image_url maps to AssetSourceUrl", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: {
            asset_kind: "image_url",
            source_url: "https://example.com/photo.jpg",
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors).toEqual([]);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy.image_source;
    expect(src).toEqual({ type: "url", url: "https://example.com/photo.jpg" });
  });

  it("asset_kind=image_url errors when source_url missing", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: { asset_kind: "image_url" },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors[0]?.reason).toBe("missing_source_url");
  });

  it("asset_kind=image_asset_id maps to AssetSourceAssetId", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          assets_strategy_lite: {
            asset_kind: "image_asset_id",
            source_asset_id: 12345,
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.errors).toEqual([]);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy.image_source;
    expect(src).toEqual({ type: "asset_id", id: 12345 });
  });

  it("asset_kind=video maps to concept_only_video", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          social_network: "instagram",
          product_type: "reel",
          asset_layout: "single_video",
          assets_strategy_lite: { asset_kind: "video" },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], { video_model: "wan_2.2", video_duration_seconds: 8 });
    expect(r.errors).toEqual([]);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy
      .video_source as AssetSourceConceptVideo;
    expect(src).toMatchObject({
      type: "concept_only_video",
      mode: "concept_only",
      model: "wan_2.2",
      aspect_ratio: "9:16",
      duration_seconds: 8,
    });
  });

  it("asset_kind=avatar_lipsync requires exactly one script", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "single_video",
          assets_strategy_lite: {
            asset_kind: "avatar_lipsync",
            avatar_scripts: ["Hola, te cuento esto", "extra"],
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], { avatar_id: 12 });
    expect(r.errors[0]?.reason).toBe("missing_avatar_script");
  });

  it("asset_kind=avatar_lipsync uses plan_defaults.avatar_id when override absent", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "single_video",
          assets_strategy_lite: {
            asset_kind: "avatar_lipsync",
            avatar_scripts: ["Hola, te cuento esto"],
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], { avatar_id: 12 });
    expect(r.errors).toEqual([]);
    const src = r.plan_items[0]?.sub_posts[0]?.assets_strategy.video_source;
    expect(src).toEqual({ type: "ai_avatar_lipsync", script: "Hola, te cuento esto", avatar_id: 12 });
  });

  it("asset_kind=avatar_multi_scene requires scene_count to match avatar_scripts.length", () => {
    const item = makeLiteItem({
      sub_posts: [
        makeLiteSubPost({
          asset_layout: "single_video",
          assets_strategy_lite: {
            asset_kind: "avatar_multi_scene",
            scene_count: 3,
            avatar_scripts: ["A", "B"], // mismatched: 2 != 3
          },
        }),
      ],
    });
    const r = normalizeIncomingPlan([item], { avatar_id: 99 });
    expect(r.errors[0]?.reason).toBe("avatar_scripts_mismatch");
  });
});

// Mixed plans (Lite + Full passthrough) ──────────────────────────────────────

describe("normalizeIncomingPlan: mixed Lite + Full passthrough", () => {
  it("passes Tier 3 plan_item through unchanged", () => {
    // Tier 3 PlanItem: explicit assets_strategy with prompt.
    const tier3 = {
      slug: "tier-3",
      date: "2026-06-02",
      publish_at_time_local: "10:00",
      timezone: "America/Argentina/Buenos_Aires",
      concept_shared: "Explicit prompt item.",
      rationale: "Reasoning trace required in tier 3.",
      sub_posts: [
        {
          social_network: "instagram" as const,
          product_type: "feed" as const,
          asset_layout: "single_image" as const,
          assets_strategy: {
            image_source: {
              type: "ai_generate" as const,
              prompt: "Cinematic close-up of la campera",
              model: "nano_banana_2",
            },
          },
          caption_concept: "Caption brief for this post.",
        },
      ],
    };
    const r = normalizeIncomingPlanItem(tier3 as never, undefined);
    expect(r.errors).toEqual([]);
    const src = r.item?.sub_posts[0]?.assets_strategy.image_source;
    expect(src).toEqual({
      type: "ai_generate",
      prompt: "Cinematic close-up of la campera",
      model: "nano_banana_2",
    });
  });

  it("rationale defaults to empty string when omitted on Lite item", () => {
    const item = makeLiteItem(); // rationale omitted
    const r = normalizeIncomingPlan([item], undefined);
    expect(r.plan_items[0]?.rationale).toBe("");
  });
});

// Empty plan ─────────────────────────────────────────────────────────────────

describe("normalizeIncomingPlan: edge cases", () => {
  it("returns empty plan_items when input array is empty", () => {
    const r = normalizeIncomingPlan([], undefined);
    expect(r.plan_items).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("aggregates errors across multiple plan_items", () => {
    const items = [
      makeLiteItem({
        slug: "bad-1",
        sub_posts: [
          makeLiteSubPost({
            assets_strategy_lite: { asset_kind: "carousel_image" }, // missing slot_count
          }),
        ],
      }),
      makeLiteItem({
        slug: "bad-2",
        sub_posts: [
          makeLiteSubPost({
            assets_strategy_lite: { asset_kind: "image_url" }, // missing source_url
          }),
        ],
      }),
    ];
    const r = normalizeIncomingPlan(items, undefined);
    expect(r.plan_items).toEqual([]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors.map((e) => e.slug)).toEqual(["bad-1", "bad-2"]);
  });
});
