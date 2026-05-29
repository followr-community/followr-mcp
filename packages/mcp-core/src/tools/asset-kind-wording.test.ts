// Asset-kind wording tests.
//
// The labels produced by describeAssetKind feed both preview_plan_item
// rendered_markdown and the summary table. They are the primary cue the user
// uses to mentally evaluate the plan ("avatar narrando" vs "video con IA sin
// persona en cámara"). Two regressions to defend against:
//
//   1. Jargon that confused the real PipeLime 2026-05-28 session — "voz
//      sintética" and "subtítulos quemados" are video-production terms that
//      end users do not parse. The replacement strings stay plain Spanish.
//   2. The user cannot tell avatar from AI-generated video. The labels must
//      contain explicit markers like "avatar hablando" or "sin persona a
//      cámara". This is the contract upstream renderers rely on.

import { describe, it, expect } from "vitest";

import { describeAssetKind } from "./content-plan.js";
import type { AssetPreview } from "./content-plan.js";

const BANNED = [
  "voz sintética",
  "voz sintetica",
  "subtítulos quemados",
  "subtitulos quemados",
  "sintetizada",
  "quemados",
];

function assertNoJargon(label: string) {
  for (const phrase of BANNED) {
    expect(label.toLowerCase()).not.toContain(phrase.toLowerCase());
  }
}

describe("describeAssetKind: avatar lipsync wording", () => {
  it("describes ai_avatar_lipsync as a single-scene avatar shot without subtitles", () => {
    const a: AssetPreview = {
      kind: "avatar_lipsync",
      description: "x",
      cost_credits: 200,
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Avatar hablando");
    expect(label).toContain("una única escena");
    expect(label).toContain("sin subtítulos");
    expect(label).toContain("200 cr");
    assertNoJargon(label);
  });
});

describe("describeAssetKind: avatar multi-scene wording", () => {
  it("describes avatar_video as multi-scene avatar narration WITH subtitles", () => {
    const a: AssetPreview = {
      kind: "avatar_video",
      description: "x",
      cost_credits: 500,
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Avatar hablando");
    expect(label).toContain("varias escenas anidadas");
    expect(label).toContain("con subtítulos");
    expect(label).toContain("500 cr");
    assertNoJargon(label);
  });
});

describe("describeAssetKind: AI video clip wording", () => {
  it("flags ai_video as 'video corto con IA' AND 'sin persona a cámara'", () => {
    const a: AssetPreview = {
      kind: "ai_video",
      description: "x",
      model: "veo_3.1_fast",
      duration_seconds: 8,
      cost_credits: 400,
      audio_status: "with_native_audio",
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Video corto con IA");
    expect(label).toContain("sin persona a cámara");
    expect(label).toContain("con sonido");
    expect(label).toContain("8s");
    expect(label).toContain("400 cr");
    assertNoJargon(label);
  });

  it("marks silent variant of ai_video for editor-added music expectation", () => {
    const a: AssetPreview = {
      kind: "ai_video",
      description: "x",
      model: "wan_2.2",
      duration_seconds: 8,
      cost_credits: 80,
      audio_status: "silent_video",
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Video corto con IA");
    expect(label).toContain("sin persona a cámara");
    expect(label).toContain("sin sonido");
    assertNoJargon(label);
  });
});

describe("describeAssetKind: image kinds keep plain wording", () => {
  it("ai_image label mentions IA and cost, no jargon", () => {
    const a: AssetPreview = {
      kind: "ai_image",
      description: "x",
      model: "nano_banana_2",
      cost_credits: 25,
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Imagen generada con IA");
    expect(label).toContain("25 cr");
    assertNoJargon(label);
  });

  it("url_image label says 'Foto del sitio'", () => {
    const a: AssetPreview = {
      kind: "url_image",
      description: "x",
      cost_credits: 0,
    };
    const label = describeAssetKind(a);
    expect(label).toContain("Foto del sitio");
    assertNoJargon(label);
  });

  it("library_image label refers to the user's biblioteca", () => {
    const a: AssetPreview = {
      kind: "library_image",
      description: "x",
      cost_credits: 0,
    };
    const label = describeAssetKind(a);
    expect(label).toContain("biblioteca");
    assertNoJargon(label);
  });
});
