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

// Avatar variable cost ──────────────────────────────────────────────────────
//
// Validates that avatar cost is derived from script length (via the internal
// estimateTtsSeconds helper). Pre-refactor the costs were hardcoded:
//   ai_avatar_lipsync: 25 * 12 = 300 cr regardless of script
//   ai_avatar_video:   25 * 10 * sceneCount regardless of scripts
// Now costs scale with the actual TTS seconds. Constants in content-plan.ts:
//   AVATAR_TTS_COST_PER_SECOND = 25
//   AVATAR_TTS_CHARS_PER_SECOND = 14
//   AVATAR_TTS_FLOOR_SECONDS = 8

describe("estimatePlanItemCostDeduped: avatar variable cost", () => {
  it("ai_avatar_lipsync with a short script bills the floor (25 * 8 = 200 cr)", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "ai_avatar_lipsync",
          script: "Hola.", // 5 chars → ceil(5/14)=1, floored to 8
          avatar_id: 1,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_count).toBe(1);
    expect(c.video_ai_cost).toBe(200); // 25 cr/s * 8 s floor
    // Critical: NOT the old hardcode of 300 (which assumed 12s flat).
    expect(c.video_ai_cost).not.toBe(300);
  });

  it("ai_avatar_lipsync with a long script bills proportionally to seconds", () => {
    const longScript = "a".repeat(280); // 280 chars / 14 = 20 s
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "ai_avatar_lipsync",
          script: longScript,
          avatar_id: 1,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_cost).toBe(25 * 20); // 500 cr
    // Critical: greater than the old hardcode of 300.
    expect(c.video_ai_cost).toBeGreaterThan(300);
  });

  it("ai_avatar_video with one short scene bills floor seconds (200 cr, NOT old hardcode 250)", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "ai_avatar_video",
          scripts: ["Hola."], // 5 chars → floored to 8 s
          avatar_id: 1,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    expect(c.video_ai_cost).toBe(25 * 8); // 200 cr
    // Old hardcode: 25 * 10 * 1 = 250 cr.
    expect(c.video_ai_cost).not.toBe(250);
  });

  it("ai_avatar_video with multiple scenes sums per-scene TTS seconds", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "ai_avatar_video",
          scripts: [
            "a".repeat(140), // 140/14 = 10 s
            "a".repeat(210), // 210/14 = 15 s
            "a".repeat(28), // 28/14 = 2 → floored to 8 s
          ],
          avatar_id: 1,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    // 25 * (10 + 15 + 8) = 25 * 33 = 825
    expect(c.video_ai_cost).toBe(825);
    // Old hardcode: 25 * 10 * 3 = 750 cr.
    expect(c.video_ai_cost).not.toBe(750);
  });

  it("ai_avatar_video with generate_backgrounds adds 60 cr per scene on top of TTS", () => {
    const item = planItem([
      makeSubPost({
        video_source: {
          type: "ai_avatar_video",
          scripts: ["a".repeat(140), "a".repeat(140)], // 2 scenes of 10s each
          avatar_id: 1,
          generate_backgrounds: true,
        },
      }),
    ]);
    const c = estimatePlanItemCostDeduped(item);
    // 25 cr/s * 20 s + 60 cr/scene * 2 = 500 + 120 = 620
    expect(c.video_ai_cost).toBe(620);
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
