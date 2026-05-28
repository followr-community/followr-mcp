import { describe, it, expect } from "vitest";

import type { PipelineState } from "../lib/pipeline-state.js";
import { buildPendingPipelineIntro } from "./pipelines.js";

// Minimal builder so each test only spells out the fields it cares about.
// Defaults align with a freshly-completed content_plan_execution pipeline
// (the branch we are exercising); other phases override via overrides.
function makeState(overrides: Partial<PipelineState> = {}): PipelineState {
  const now = Date.now();
  return {
    pipeline_id: "pip_test",
    kind: "content_plan_execution",
    company_id: 7,
    execution_id: "exec_test",
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + 60_000,
    terminal_at_ms: now,
    acknowledged_at_ms: null,
    phase: "completed",
    current_sub_phase: "completed",
    progress: { completed: 1, total: 1 },
    estimated_remaining_seconds: 0,
    cancel_requested: false,
    sub_jobs: {},
    result: null,
    failure: null,
    params: {},
    ...overrides,
  };
}

describe("buildPendingPipelineIntro: content_plan_execution partial_publish", () => {
  it("calls out the auto-skipped network and offers retry without skip_networks", () => {
    // Real shape this branch sees: skip_failed_networks auto-skipped TikTok
    // after its upload failed; IG + FB succeeded.
    const state = makeState({
      result: {
        metadata: {
          status: "succeeded",
          partial_publish: true,
          totals: {
            plan_items_attempted: 1,
            succeeded: 1,
            failed: 0,
            sub_posts_skipped_total: 1,
          },
          skipped_networks_histogram: { tiktok: { manual: 0, auto: 1 } },
          auto_skipped_networks: ["tiktok"],
        },
      },
    });

    const intro = buildPendingPipelineIntro(state, 1);

    expect(intro).toMatch(/PUBLICACIÓN PARCIAL/);
    expect(intro).toMatch(/tiktok/);
    expect(intro).toMatch(/auto-skip/);
    expect(intro).toMatch(/execute_content_plan/);
    expect(intro).toMatch(/sin skip_networks/);
    expect(intro).toMatch(/mark_pipeline_acknowledged/);
  });

  it("distinguishes manual skip from auto skip in the intro text", () => {
    const state = makeState({
      result: {
        metadata: {
          status: "succeeded",
          partial_publish: true,
          totals: {
            plan_items_attempted: 1,
            succeeded: 1,
            failed: 0,
            sub_posts_skipped_total: 1,
          },
          skipped_networks_histogram: { tiktok: { manual: 1, auto: 0 } },
          auto_skipped_networks: [],
        },
      },
    });

    const intro = buildPendingPipelineIntro(state, 0);

    expect(intro).toMatch(/PUBLICACIÓN PARCIAL/);
    // Manual-only skips get a different retry hint than auto skips.
    expect(intro).toMatch(/salteadas a pedido/);
    // And don't suggest "reintentar las que fallaron" since none failed.
    expect(intro).not.toMatch(/auto-skip pueden reintentarse/);
  });

  it("uses the full-success intro when nothing was skipped", () => {
    const state = makeState({
      result: {
        metadata: {
          status: "succeeded",
          partial_publish: false,
          totals: {
            plan_items_attempted: 3,
            succeeded: 3,
            failed: 0,
            sub_posts_skipped_total: 0,
          },
          skipped_networks_histogram: {},
          auto_skipped_networks: [],
        },
      },
    });

    const intro = buildPendingPipelineIntro(state, 2);

    expect(intro).not.toMatch(/PUBLICACIÓN PARCIAL/);
    expect(intro).toMatch(/terminó completo/);
    expect(intro).toMatch(/3\/3 items publicados/);
    expect(intro).toMatch(/mark_pipeline_acknowledged/);
  });

  it("falls back gracefully when totals are missing", () => {
    const state = makeState({
      result: {
        metadata: {
          status: "succeeded",
          partial_publish: false,
        },
      },
    });

    const intro = buildPendingPipelineIntro(state, 1);

    // Don't try to format unknown numerics; show the status from metadata.
    expect(intro).toMatch(/Resultado: succeeded/);
  });

  it("does not enter the partial-publish branch for non-content_plan_execution kinds", () => {
    const state = makeState({
      kind: "avatar_video",
      result: {
        metadata: {
          // Even if this metadata exists for some reason, the avatar_video
          // path uses the generic completed intro, not the content_plan one.
          partial_publish: true,
        },
      },
    });

    const intro = buildPendingPipelineIntro(state, 1);

    expect(intro).not.toMatch(/PUBLICACIÓN PARCIAL/);
    expect(intro).toMatch(/un reel con avatar/);
  });
});
