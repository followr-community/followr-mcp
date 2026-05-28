// Tests for fingerprintAssetSource — the function that produces a stable
// dedup key per AssetSource. Critical for cross-network dedupe both in
// Tier 3 (ai_generate with shared_concept_key OR exact prompt) and in
// Tier 1 (concept_only_image structural fingerprint).

import { describe, it, expect } from "vitest";

import {
  fingerprintAssetSource,
  type AssetSourceRef,
} from "./content-plan.js";
import type {
  AssetSourceAiImage,
  AssetSourceConceptImage,
  AssetSourceConceptVideo,
} from "../lib/content-plan-state.js";

// Helpers for building refs ─────────────────────────────────────────────────

function imageRef(src: AssetSourceAiImage | AssetSourceConceptImage): AssetSourceRef {
  return { src, mode: "image" };
}

function videoRef(src: AssetSourceConceptVideo, aspect: "9:16" | "16:9" = "9:16"): AssetSourceRef {
  return { src, mode: "video", aspect_ratio: aspect };
}

function concept(overrides: Partial<AssetSourceConceptImage> = {}): AssetSourceConceptImage {
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

function conceptVideo(
  overrides: Partial<AssetSourceConceptVideo> = {},
): AssetSourceConceptVideo {
  return {
    type: "concept_only_video",
    mode: "concept_only",
    model: "wan_2.2",
    aspect_ratio: "9:16",
    duration_seconds: 8,
    ...overrides,
  };
}

// Basic types ────────────────────────────────────────────────────────────────

describe("fingerprintAssetSource: basic types", () => {
  it("url has stable fingerprint based on URL", () => {
    const a = fingerprintAssetSource(imageRef({ type: "url", url: "https://x/a.jpg" } as never));
    const b = fingerprintAssetSource(imageRef({ type: "url", url: "https://x/a.jpg" } as never));
    expect(a).toBe(b);
    expect(a).toContain("url:");
  });

  it("asset_id has stable fingerprint based on id", () => {
    const a = fingerprintAssetSource(imageRef({ type: "asset_id", id: 42 } as never));
    const b = fingerprintAssetSource(imageRef({ type: "asset_id", id: 42 } as never));
    expect(a).toBe(b);
    expect(a).toContain("id:42");
  });

  it("ai_generate (Tier 3) with shared_concept_key short-circuits to a stable key fingerprint", () => {
    const a = fingerprintAssetSource(
      imageRef({
        type: "ai_generate",
        prompt: "A really long prompt that varies a lot",
        shared_concept_key: "cover",
      } as AssetSourceAiImage),
    );
    const b = fingerprintAssetSource(
      imageRef({
        type: "ai_generate",
        prompt: "Different prompt entirely",
        shared_concept_key: "cover",
      } as AssetSourceAiImage),
    );
    expect(a).toBe(b);
    expect(a).toContain("ai_image:shared:cover");
  });
});

// Tier 1 concept_only_image dedup ────────────────────────────────────────────

describe("fingerprintAssetSource: Tier 1 concept_only_image", () => {
  it("same kind / model / aspect / slot / mode -> same fingerprint (cross-network dedup)", () => {
    const a = fingerprintAssetSource(imageRef(concept()));
    const b = fingerprintAssetSource(imageRef(concept()));
    expect(a).toBe(b);
  });

  it("different slot_index -> different fingerprints (carousel slots stay distinct)", () => {
    const a = fingerprintAssetSource(imageRef(concept({ slot_index: 0, slot_count: 5 })));
    const b = fingerprintAssetSource(imageRef(concept({ slot_index: 1, slot_count: 5 })));
    expect(a).not.toBe(b);
  });

  it("different model -> different fingerprints", () => {
    const a = fingerprintAssetSource(imageRef(concept({ model: "nano_banana_2" })));
    const b = fingerprintAssetSource(imageRef(concept({ model: "nano_banana_pro" })));
    expect(a).not.toBe(b);
  });

  it("different aspect_ratio -> different fingerprints", () => {
    const a = fingerprintAssetSource(imageRef(concept({ aspect_ratio: "1:1" })));
    const b = fingerprintAssetSource(imageRef(concept({ aspect_ratio: "9:16" })));
    expect(a).not.toBe(b);
  });

  it("different mode (Path A vs B) -> different fingerprints", () => {
    const a = fingerprintAssetSource(imageRef(concept({ mode: "concept_only" })));
    const b = fingerprintAssetSource(
      imageRef(concept({ mode: "explicit_brief", art_direction_hint: "épico" })),
    );
    expect(a).not.toBe(b);
  });

  it("different art_direction_hint (Path B) -> different fingerprints", () => {
    const a = fingerprintAssetSource(
      imageRef(concept({ mode: "explicit_brief", art_direction_hint: "épico" })),
    );
    const b = fingerprintAssetSource(
      imageRef(concept({ mode: "explicit_brief", art_direction_hint: "minimalista" })),
    );
    expect(a).not.toBe(b);
  });

  it("same art_direction_hint -> same fingerprints (Path B dedup)", () => {
    const a = fingerprintAssetSource(
      imageRef(concept({ mode: "explicit_brief", art_direction_hint: "épico" })),
    );
    const b = fingerprintAssetSource(
      imageRef(concept({ mode: "explicit_brief", art_direction_hint: "épico" })),
    );
    expect(a).toBe(b);
  });

  it("different literal_prompt (Path C) -> different fingerprints", () => {
    const a = fingerprintAssetSource(
      imageRef(concept({ mode: "literal_prompt", literal_prompt: "85mm, golden hour" })),
    );
    const b = fingerprintAssetSource(
      imageRef(concept({ mode: "literal_prompt", literal_prompt: "35mm, neon lights" })),
    );
    expect(a).not.toBe(b);
  });

  it("different reference_image_urls -> different fingerprints", () => {
    const a = fingerprintAssetSource(
      imageRef(concept({ reference_image_urls: ["https://x/1.jpg"] })),
    );
    const b = fingerprintAssetSource(
      imageRef(concept({ reference_image_urls: ["https://x/2.jpg"] })),
    );
    expect(a).not.toBe(b);
  });
});

// Tier 1 concept_only_video dedup ────────────────────────────────────────────

describe("fingerprintAssetSource: Tier 1 concept_only_video", () => {
  it("same kind / model / aspect / duration / mode -> same fingerprint", () => {
    const a = fingerprintAssetSource(videoRef(conceptVideo()));
    const b = fingerprintAssetSource(videoRef(conceptVideo()));
    expect(a).toBe(b);
  });

  it("different duration_seconds -> different fingerprints", () => {
    const a = fingerprintAssetSource(videoRef(conceptVideo({ duration_seconds: 8 })));
    const b = fingerprintAssetSource(videoRef(conceptVideo({ duration_seconds: 12 })));
    expect(a).not.toBe(b);
  });

  it("different model -> different fingerprints", () => {
    const a = fingerprintAssetSource(videoRef(conceptVideo({ model: "wan_2.2" })));
    const b = fingerprintAssetSource(videoRef(conceptVideo({ model: "veo_3_fast" })));
    expect(a).not.toBe(b);
  });
});

// Reuse across networks (the primary use case) ──────────────────────────────

describe("fingerprintAssetSource: cross-network reuse fingerprints", () => {
  it("IG single image and FB single image (same spec) share a fingerprint", () => {
    // Both sub_posts (IG + FB) declare concept_only_image with identical
    // spec via plan_defaults. The fingerprint collapses them to one
    // generation; the executor charges once.
    const ig = fingerprintAssetSource(imageRef(concept()));
    const fb = fingerprintAssetSource(imageRef(concept()));
    expect(ig).toBe(fb);
  });

  it("IG carousel slot 0 and FB carousel slot 0 (same spec) share fingerprint", () => {
    const ig = fingerprintAssetSource(imageRef(concept({ slot_index: 0, slot_count: 5 })));
    const fb = fingerprintAssetSource(imageRef(concept({ slot_index: 0, slot_count: 5 })));
    expect(ig).toBe(fb);
  });

  it("IG carousel slot 0 and FB carousel slot 1 do NOT share (different slots)", () => {
    const ig = fingerprintAssetSource(imageRef(concept({ slot_index: 0, slot_count: 5 })));
    const fb = fingerprintAssetSource(imageRef(concept({ slot_index: 1, slot_count: 5 })));
    expect(ig).not.toBe(fb);
  });
});
