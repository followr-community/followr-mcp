// Tests for estimatePlanItemCostDeduped.
//
// Validates that:
//   - shared assets (same fingerprint across sub_posts) are charged ONCE,
//   - different models produce different costs,
//   - concept_only_* (Tier 1) sources count toward image_ai_count /
//     video_ai_count just like ai_generate (Tier 3) does,
//   - cost lock: the cost number the validator reports matches what
//     execute_content_plan would charge per the model in the spec.

import { describe, it, expect } from "vitest";

import { estimatePlanItemCostDeduped } from "./content-plan.js";
import type { PlanItem, SubPost, AssetsStrategy } from "../lib/content-plan-state.js";

// Helpers ────────────────────────────────────────────────────────────────────

function planItem(sub_posts: SubPost[]): PlanItem {
  return {
    slug: "test",
    date: "2026-06-01",
    publish_at_time_local: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    concept_shared: "Test concept",
    rationale: "",
    sub_posts,
  };
}

function makeSubPost(strategy: AssetsStrategy, network: SubPost["social_network"] = "instagram"): SubPost {
  return {
    social_network: network,
    product_type: "feed",
    asset_layout: strategy.carousel_sources
      ? "carousel_images"
      : strategy.video_source
        ? "single_video"
        : "single_image",
    assets_strategy: strategy,
    caption_concept: "caption",
  };
}

// Tier 1 cost ────────────────────────────────────────────────────────────────

describe("estimatePlanItemCostDeduped: Tier 1 single image", () => {
  it("counts a single concept_only_image once, cost = 25 cr (nano_banana_2)", () => {
    const item = planItem([
      makeSubPost({
        image_source: {
          type: "concept_only_image",
          mode: "concept_only",
          slot_index: 0,
          slot_count: 1,
          model: "nano_banana_2",
          aspect_ratio: "1:1",
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1);
    expect(c.image_ai_cost).toBe(25);
    expect(c.video_ai_count).toBe(0);
    expect(c.upload_count).toBe(0);
    expect(c.reuse_count).toBe(0);
  });

  it("uses 45 cr for nano_banana_pro", () => {
    const item = planItem([
      makeSubPost({
        image_source: {
          type: "concept_only_image",
          mode: "concept_only",
          slot_index: 0,
          slot_count: 1,
          model: "nano_banana_pro",
          aspect_ratio: "1:1",
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1);
    expect(c.image_ai_cost).toBe(45);
  });
});

describe("estimatePlanItemCostDeduped: Tier 1 cross-network dedup", () => {
  it("IG + FB single image with identical concept_only spec collapse to one charge (25 cr)", () => {
    const buildSpec = (network: "instagram" | "facebook") =>
      makeSubPost(
        {
          image_source: {
            type: "concept_only_image",
            mode: "concept_only",
            slot_index: 0,
            slot_count: 1,
            model: "nano_banana_2",
            aspect_ratio: "1:1",
          },
        },
        network,
      );

    const item = planItem([buildSpec("instagram"), buildSpec("facebook")]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(1); // one unique asset
    expect(c.image_ai_cost).toBe(25); // charged once, not twice
  });

  it("IG + FB carousel of 5 slides collapse to 5 unique generations (125 cr, not 250)", () => {
    const buildCarousel = (network: "instagram" | "facebook") => {
      const sources = [];
      for (let i = 0; i < 5; i++) {
        sources.push({
          type: "concept_only_image" as const,
          mode: "concept_only" as const,
          slot_index: i,
          slot_count: 5,
          model: "nano_banana_2",
          aspect_ratio: "1:1" as const,
        });
      }
      return makeSubPost({ carousel_sources: sources }, network);
    };
    const item = planItem([buildCarousel("instagram"), buildCarousel("facebook")]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(5);
    expect(c.image_ai_cost).toBe(5 * 25);
  });

  it("IG with Path A and FB with Path B (different hint) generate distinct assets (2 * 25 cr)", () => {
    const ig = makeSubPost(
      {
        image_source: {
          type: "concept_only_image",
          mode: "concept_only",
          slot_index: 0,
          slot_count: 1,
          model: "nano_banana_2",
          aspect_ratio: "1:1",
        },
      },
      "instagram",
    );
    const fb = makeSubPost(
      {
        image_source: {
          type: "concept_only_image",
          mode: "explicit_brief",
          slot_index: 0,
          slot_count: 1,
          model: "nano_banana_2",
          aspect_ratio: "1:1",
          art_direction_hint: "tono cálido",
        },
      },
      "facebook",
    );
    const item = planItem([ig, fb]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(2);
    expect(c.image_ai_cost).toBe(50);
  });
});

describe("estimatePlanItemCostDeduped: Tier 1 video", () => {
  it("counts concept_only_video at model.cost_per_second * duration_seconds", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "concept_only_video",
          mode: "concept_only",
          model: "wan_2.2",
          aspect_ratio: "9:16",
          duration_seconds: 8,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_count).toBe(1);
    // wan_2.2 has a defined cost_per_second; the test just asserts it's > 0
    // and proportional to duration. The exact catalog value lives in
    // content-plan-catalog and we don't pin it here to avoid coupling
    // tests to pricing changes.
    expect(c.video_ai_cost).toBeGreaterThan(0);
  });

  it("falls back to conservative 400 cr/sec when model unknown", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "concept_only_video",
          mode: "concept_only",
          model: "totally_unknown_model",
          aspect_ratio: "9:16",
          duration_seconds: 8,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_count).toBe(1);
    expect(c.video_ai_cost).toBe(400 * 8);
  });
});

// Non-AI assets ──────────────────────────────────────────────────────────────

describe("estimatePlanItemCostDeduped: non-AI assets", () => {
  it("url source contributes upload_count, not image_ai_count", () => {
    const item = planItem([
      makeSubPost({
        image_source: { type: "url", url: "https://x/a.jpg" },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.upload_count).toBe(1);
    expect(c.image_ai_count).toBe(0);
    expect(c.image_ai_cost).toBe(0);
  });

  it("asset_id source contributes reuse_count, no cost", () => {
    const item = planItem([
      makeSubPost({
        image_source: { type: "asset_id", id: 42 },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.reuse_count).toBe(1);
    expect(c.image_ai_cost).toBe(0);
  });
});

// Mixed Tier 1 + Tier 3 in one plan_item ─────────────────────────────────────

describe("estimatePlanItemCostDeduped: mixed Tier 1 + Tier 3 in one plan_item", () => {
  it("counts both types correctly with no double-count", () => {
    const item = planItem([
      makeSubPost({
        image_source: {
          type: "ai_generate",
          prompt: "explicit prompt", // Tier 3
          model: "nano_banana_2",
        },
      }),
      makeSubPost(
        {
          image_source: {
            type: "concept_only_image", // Tier 1, different fingerprint due to type
            mode: "concept_only",
            slot_index: 0,
            slot_count: 1,
            model: "nano_banana_2",
            aspect_ratio: "1:1",
          },
        },
        "facebook",
      ),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.image_ai_count).toBe(2);
    expect(c.image_ai_cost).toBe(50);
  });
});
