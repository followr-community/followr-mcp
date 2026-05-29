// Video-kind deviation detection tests.
//
// Replaces the silent auto-corrector (autoCorrectInvertedVideoSources, deleted
// 2026-05-29). The detection now surfaces deviations as user-facing warnings
// routed to upfront_decisions_required. These tests pin the behavior:
//
//   - service_b2b (default ai_avatar_video) + ai_generate sub_post → 1 deviation
//     (cross-family flip). The Saturday PipeLime 2026-05-28 regression that
//     drove the rewrite.
//   - service_b2b + ai_avatar_video sub_post → 0 deviations (matches default).
//   - service_b2b + ai_avatar_lipsync sub_post → 1 deviation (single-scene
//     within-family downgrade vs the multi-scene default).
//   - ecommerce_fashion (default ai_clip) + ai_avatar_video sub_post → 1
//     deviation (inverse flip).
//   - generic_business (is_ambiguous: true) → 0 deviations always (no
//     opinionated default to defend).
//   - default ai_avatar_video + 0 avatares in inventory → 0 deviations (the
//     upstream avatar_setup_proposal already pidió que cree uno; nagging
//     after that would be noise).
//   - Mixed plan: some sub_posts deviate and some match → exactly the
//     deviating ones are reported.
//   - url / asset_id / concept_only_video sources → never count as deviations
//     (user explicit choice, not LLM auto-pick).

import { describe, it, expect } from "vitest";

import { collectVideoKindDeviations } from "./content-plan.js";
import type { PlanItem, SubPost } from "../lib/content-plan-state.js";
import type { FollowrClient } from "@followr-mcp/shared";

// Minimal client mock. Only the listAvatars call inside
// collectVideoKindDeviations matters; all other methods are intentionally
// missing because the function never invokes them. The cast at the use site
// keeps the test free of unrelated stub fields.
type Avatar = { id: number; default?: boolean };
function mockClient(avatars: Avatar[] | "throw"): FollowrClient {
  return {
    listAvatars: async (_companyId: number, _opts?: { pageSize?: number }) => {
      if (avatars === "throw") throw new Error("simulated avatar fetch failure");
      return avatars;
    },
  } as unknown as FollowrClient;
}

function avatarVideoSubPost(scripts: string[] = ["Hola, te cuento."], network: SubPost["social_network"] = "tiktok"): SubPost {
  return {
    social_network: network,
    product_type: "feed",
    asset_layout: "single_video",
    assets_strategy: {
      video_source: {
        type: "ai_avatar_video",
        scripts,
        avatar_id: 1,
      },
    },
    caption_concept: "narrar el concepto",
  };
}
function avatarLipsyncSubPost(script = "Hola.", network: SubPost["social_network"] = "tiktok"): SubPost {
  return {
    social_network: network,
    product_type: "feed",
    asset_layout: "single_video",
    assets_strategy: {
      video_source: { type: "ai_avatar_lipsync", script, avatar_id: 1 },
    },
    caption_concept: "una toma corta",
  };
}
function aiGenerateSubPost(prompt = "pipeline visual", network: SubPost["social_network"] = "tiktok"): SubPost {
  return {
    social_network: network,
    product_type: "feed",
    asset_layout: "single_video",
    assets_strategy: {
      video_source: {
        type: "ai_generate",
        model: "veo_3.1_fast",
        prompt,
        duration_seconds: 8,
      },
    },
    caption_concept: "pipeline en movimiento",
  };
}
function urlVideoSubPost(): SubPost {
  return {
    social_network: "tiktok",
    product_type: "feed",
    asset_layout: "single_video",
    assets_strategy: {
      video_source: { type: "url", url: "https://x/v.mp4" },
    },
    caption_concept: "uploaded clip",
  };
}
function planItem(slug: string, concept: string, sub_posts: SubPost[]): PlanItem {
  return {
    slug,
    date: "2026-06-01",
    publish_at_time_local: "12:00",
    timezone: "America/Argentina/Buenos_Aires",
    concept_shared: concept,
    rationale: "",
    sub_posts,
  };
}

describe("collectVideoKindDeviations: avatar-default industries (service_b2b)", () => {
  it("flags ai_generate as a deviation (Saturday PipeLime regression)", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("sab-3-pasos", "Cómo funciona PipeLime en 3 pasos", [
        aiGenerateSubPost(),
      ]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(1);
    expect(out[0]!.chosen_kind).toBe("ai_generate");
    expect(out[0]!.expected_default_kind).toBe("ai_avatar_video");
    expect(out[0]!.slug).toBe("sab-3-pasos");
    expect(out[0]!.network).toBe("tiktok");
    expect(out[0]!.concept).toContain("Cómo funciona");
  });

  it("does NOT flag ai_avatar_video sub_posts (matches default)", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("vie-hook", "Hook de dolor", [avatarVideoSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(0);
  });

  it("flags ai_avatar_lipsync as a within-family shape deviation", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("toma-corta", "Toma corta", [avatarLipsyncSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(1);
    expect(out[0]!.chosen_kind).toBe("ai_avatar_lipsync");
    expect(out[0]!.expected_default_kind).toBe("ai_avatar_video");
  });

  it("returns zero deviations when no avatar inventory (upstream proposal handles it)", async () => {
    const client = mockClient([]);
    const items = [
      planItem("sab-3-pasos", "Cómo funciona", [aiGenerateSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(0);
  });

  it("returns zero deviations when listAvatars throws transiently", async () => {
    const client = mockClient("throw");
    const items = [
      planItem("sab-3-pasos", "Cómo funciona", [aiGenerateSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(0);
  });
});

describe("collectVideoKindDeviations: ai_clip-default industries (ecommerce_fashion)", () => {
  it("flags ai_avatar_video as a deviation (inverse flip)", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("lanzamiento", "Lanzamiento de colección", [
        avatarVideoSubPost(),
      ]),
    ];
    const out = await collectVideoKindDeviations(
      client,
      42,
      "ecommerce_fashion",
      items,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.chosen_kind).toBe("ai_avatar_video");
    expect(out[0]!.expected_default_kind).toBe("ai_clip");
  });

  it("does NOT flag ai_generate sub_posts (matches default)", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("drop", "Drop visual de colección", [aiGenerateSubPost()]),
    ];
    const out = await collectVideoKindDeviations(
      client,
      42,
      "ecommerce_fashion",
      items,
    );
    expect(out).toHaveLength(0);
  });
});

describe("collectVideoKindDeviations: ambiguous and edge industries", () => {
  it("generic_business (is_ambiguous: true) returns zero deviations always", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("test", "Cualquier concepto", [
        aiGenerateSubPost(),
        avatarVideoSubPost(),
        avatarLipsyncSubPost(),
      ]),
    ];
    const out = await collectVideoKindDeviations(
      client,
      42,
      "generic_business",
      items,
    );
    expect(out).toHaveLength(0);
  });

  it("unknown cached_industry_id returns zero deviations", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("test", "Concept", [aiGenerateSubPost()]),
    ];
    const out = await collectVideoKindDeviations(
      client,
      42,
      "fake_industry_that_does_not_exist",
      items,
    );
    expect(out).toHaveLength(0);
  });

  it("null cached_industry_id returns zero deviations", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("test", "Concept", [aiGenerateSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, null, items);
    expect(out).toHaveLength(0);
  });
});

describe("collectVideoKindDeviations: user-explicit asset sources are never deviations", () => {
  it("url video source is skipped (user uploaded explicitly)", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("upload", "Concept", [urlVideoSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(0);
  });
});

describe("collectVideoKindDeviations: mixed plan reports only the deviating sub_posts", () => {
  it("returns exactly the deviating items, preserving their slug+sub_post_index", async () => {
    const client = mockClient([{ id: 1, default: true }]);
    const items = [
      planItem("vie-hook", "Hook de dolor", [avatarVideoSubPost()]),
      planItem("sab-3-pasos", "Cómo funciona", [aiGenerateSubPost()]),
      planItem("dom-prueba", "Prueba social", [avatarVideoSubPost()]),
      planItem("lun-pov", "POV outbound", [avatarLipsyncSubPost()]),
    ];
    const out = await collectVideoKindDeviations(client, 42, "service_b2b", items);
    expect(out).toHaveLength(2);
    const slugs = out.map((d) => d.slug);
    expect(slugs).toContain("sab-3-pasos");
    expect(slugs).toContain("lun-pov");
    expect(slugs).not.toContain("vie-hook");
    expect(slugs).not.toContain("dom-prueba");
  });
});
