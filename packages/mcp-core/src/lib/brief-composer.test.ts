// Tests for brief-composer.ts
//
// These exercise the pure brief-construction functions. The product the
// composer feeds (Creative Studio) is NOT called here; we only assert the
// shape and content of the brief string.

import { describe, it, expect } from "vitest";

import {
  composeImageBrief,
  composeVideoBrief,
  composeImageBriefFromSpecOnly,
  composeVideoBriefFromSpecOnly,
  detectMisroutedLiteralPrompt,
} from "./brief-composer.js";
import type {
  AssetSourceConceptImage,
  AssetSourceConceptVideo,
  PlanItem,
  SubPost,
} from "./content-plan-state.js";

// Fixtures ──────────────────────────────────────────────────────────────────

function makePlanItem(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    slug: "lun-test",
    date: "2026-06-01",
    publish_at_time_local: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    concept_shared: "Drop épico de la campera de invierno.",
    rationale: "",
    sub_posts: [],
    ...overrides,
  };
}

function makeSubPost(overrides: Partial<SubPost> = {}): SubPost {
  return {
    social_network: "instagram",
    product_type: "feed",
    asset_layout: "single_image",
    assets_strategy: {},
    caption_concept: "Hook con la calidad de la tela impermeable y CTA al sitio.",
    ...overrides,
  };
}

function makeImageSpec(overrides: Partial<AssetSourceConceptImage> = {}): AssetSourceConceptImage {
  return {
    type: "concept_only_image",
    mode: "concept_only",
    slot_index: 0,
    slot_count: 1,
    model: "nano_banana_2",
    aspect_ratio: "1:1",
    ...overrides,
  };
}

function makeVideoSpec(overrides: Partial<AssetSourceConceptVideo> = {}): AssetSourceConceptVideo {
  return {
    type: "concept_only_video",
    mode: "concept_only",
    model: "wan_2.2",
    aspect_ratio: "9:16",
    duration_seconds: 8,
    ...overrides,
  };
}

// composeImageBrief ──────────────────────────────────────────────────────────

describe("composeImageBrief", () => {
  it("includes day's concept and post brief", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost(),
      spec: makeImageSpec(),
    });
    expect(brief).toContain("Drop épico de la campera de invierno");
    expect(brief).toContain("Hook con la calidad de la tela impermeable");
  });

  it("mentions target network and format", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({
        social_network: "instagram",
        product_type: "feed",
        asset_layout: "single_image",
      }),
      spec: makeImageSpec(),
    });
    expect(brief).toContain("Instagram");
    expect(brief).toContain("Feed single image");
    expect(brief).toContain("1:1");
  });

  it("Path A (concept_only): does NOT append art_direction_hint nor literal_prompt", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost(),
      spec: makeImageSpec({ mode: "concept_only" }),
    });
    expect(brief).not.toContain("Additional creative direction");
  });

  it("Path B (explicit_brief): appends art_direction_hint", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost(),
      spec: makeImageSpec({
        mode: "explicit_brief",
        art_direction_hint: "luz dorada de atardecer",
      }),
    });
    expect(brief).toContain("Additional creative direction: luz dorada de atardecer");
  });

  it("carousel slot 1 of N is labeled as cover", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "carousel_images" }),
      spec: makeImageSpec({ slot_index: 0, slot_count: 5 }),
    });
    expect(brief).toContain("Cover slide");
    expect(brief).toContain("hook");
  });

  it("carousel last slot is labeled as closing", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "carousel_images" }),
      spec: makeImageSpec({ slot_index: 4, slot_count: 5 }),
    });
    expect(brief).toContain("Closing slide");
    expect(brief).toContain("call to action");
  });

  it("carousel middle slot is labeled as body", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "carousel_images" }),
      spec: makeImageSpec({ slot_index: 2, slot_count: 5 }),
    });
    expect(brief).toContain("Body slide");
    expect(brief).toContain("3 of 5");
  });

  it("single image (slot_count=1) does NOT mention carousel position", () => {
    const brief = composeImageBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost(),
      spec: makeImageSpec({ slot_index: 0, slot_count: 1 }),
    });
    expect(brief).not.toContain("Carousel position");
  });
});

// composeVideoBrief ──────────────────────────────────────────────────────────

describe("composeVideoBrief", () => {
  it("includes duration_seconds in brief", () => {
    const brief = composeVideoBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "single_video", product_type: "reel" }),
      spec: makeVideoSpec({ duration_seconds: 12 }),
    });
    expect(brief).toContain("12s");
  });

  it("warns about single-scene constraint", () => {
    const brief = composeVideoBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "single_video", product_type: "reel" }),
      spec: makeVideoSpec(),
    });
    expect(brief).toContain("Single continuous scene");
  });

  it("Path B appends art_direction_hint", () => {
    const brief = composeVideoBrief({
      plan_item: makePlanItem(),
      sub_post: makeSubPost({ asset_layout: "single_video", product_type: "reel" }),
      spec: makeVideoSpec({
        mode: "explicit_brief",
        art_direction_hint: "movimiento lento, cámara fija",
      }),
    });
    expect(brief).toContain("Additional creative direction: movimiento lento, cámara fija");
  });
});

// Fallback composers ─────────────────────────────────────────────────────────

describe("composeImageBriefFromSpecOnly (degraded fallback)", () => {
  it("produces a brief from spec alone (no plan_item / sub_post context)", () => {
    const brief = composeImageBriefFromSpecOnly(makeImageSpec());
    expect(brief).toContain("Generic on-brand visual");
    expect(brief).toContain("Aspect 1:1");
    expect(brief).not.toContain("Day's concept"); // doesn't have plan_item to read from
  });

  it("mentions carousel slot when slot_count > 1", () => {
    const brief = composeImageBriefFromSpecOnly(makeImageSpec({ slot_index: 2, slot_count: 5 }));
    expect(brief).toContain("Carousel slot 3 of 5");
  });

  it("includes art_direction_hint when explicit_brief", () => {
    const brief = composeImageBriefFromSpecOnly(
      makeImageSpec({ mode: "explicit_brief", art_direction_hint: "tono cálido" }),
    );
    expect(brief).toContain("Creative direction: tono cálido");
  });
});

describe("composeVideoBriefFromSpecOnly (degraded fallback)", () => {
  it("includes duration and single-scene constraint", () => {
    const brief = composeVideoBriefFromSpecOnly(makeVideoSpec({ duration_seconds: 10 }));
    expect(brief).toContain("10s");
    expect(brief).toContain("single continuous scene");
  });
});

// detectMisroutedLiteralPrompt ───────────────────────────────────────────────

describe("detectMisroutedLiteralPrompt (heuristic, 300-char threshold)", () => {
  it("does NOT flag concept_only mode (only literal_prompt matters)", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "concept_only",
        literal_prompt: undefined,
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("does NOT flag explicit_brief mode", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "explicit_brief",
        literal_prompt: undefined,
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("flags short literal_prompt without technical vocab on CS model", () => {
    const r = detectMisroutedLiteralPrompt({
      mode: "literal_prompt",
      literal_prompt: "Una foto épica del producto",
      model: "nano_banana_2",
    });
    expect(r).not.toBeNull();
    expect(r).toContain("Path C");
  });

  it("does NOT flag prompt with '85mm' (technical vocab)", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: "Close-up of la campera, 85mm lens, soft light",
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("does NOT flag prompt with 'Kodak Portra' (film stock)", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: "Cinematic shot, Kodak Portra 400",
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("does NOT flag prompt with 'F1.4'", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: "Portrait, F1.4 bokeh",
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("does NOT flag prompt >= 300 chars (assume substantial)", () => {
    const longPrompt = "X".repeat(310);
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: longPrompt,
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });

  it("does NOT flag when model is non-CS (e.g. ideogram_v3, user explicitly chose to bypass CS)", () => {
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: "Short prompt",
        model: "ideogram_v3",
      }),
    ).toBeNull();
  });

  it("flags 'sin marca' / experimental keywords", () => {
    // 'sin marca' DOES contain a technical signal ('sin\smarca' regex), so
    // detectMisroutedLiteralPrompt should NOT flag these (user knowingly
    // wants Path C for an anti-brand piece).
    expect(
      detectMisroutedLiteralPrompt({
        mode: "literal_prompt",
        literal_prompt: "Imagen sin marca, experimental",
        model: "nano_banana_2",
      }),
    ).toBeNull();
  });
});
