// Regression: the content-plan executor must interpret a plan item's
// publish_at_time_local against the item's OWN timezone, not the
// plan/company/UTC fallback chain.
//
// PipeLime 2026-06-01 (share 819a9b71): user timezone America/Buenos_Aires
// (UTC-3), the Company resource exposes no timezone field, and the plan
// carried no auto_publish_schedule, so the executor's scheduleTimezone chain
// collapsed to "UTC". A 13:00 Buenos Aires slot was stored as 13:00Z
// (= 10:00 local), publishing 3h early and already in the past at execute
// time. The past-slot guard read item.timezone and passed it as a future
// slot, so the executor and the validator disagreed by exactly the UTC-3
// offset. resolveItemPublishAtIso makes item.timezone authoritative.

import { describe, it, expect } from "vitest";

import { resolveItemPublishAtIso, buildTimezoneSetupQuestion } from "./content-plan.js";

const slot = { date: "2026-06-01", publish_at_time_local: "13:00" };

describe("resolveItemPublishAtIso: per-item timezone is authoritative", () => {
  it("interprets the slot in the item's Buenos Aires tz, not the UTC fallback", () => {
    // Company had no timezone and the plan had no auto_publish_schedule, so
    // the caller's scheduleTimezone fell back to "UTC". The item still knows
    // its real zone.
    const iso = resolveItemPublishAtIso(
      { ...slot, timezone: "America/Buenos_Aires" },
      "UTC",
    );
    // 13:00 at UTC-3 is 16:00 UTC. The bug produced "2026-06-01T13:00:00.000Z".
    expect(iso).toBe("2026-06-01T16:00:00.000Z");
  });

  it("accepts the long IANA spelling too", () => {
    const iso = resolveItemPublishAtIso(
      { ...slot, timezone: "America/Argentina/Buenos_Aires" },
      "UTC",
    );
    expect(iso).toBe("2026-06-01T16:00:00.000Z");
  });

  it("uses scheduleTimezone only when item.timezone is empty", () => {
    const iso = resolveItemPublishAtIso(
      { ...slot, timezone: "" },
      "America/Buenos_Aires",
    );
    expect(iso).toBe("2026-06-01T16:00:00.000Z");
  });

  it("stores the literal wall-clock when the item tz really is UTC", () => {
    const iso = resolveItemPublishAtIso({ ...slot, timezone: "UTC" }, "UTC");
    expect(iso).toBe("2026-06-01T13:00:00.000Z");
  });

  it("honors a Madrid item over a UTC fallback (UTC+2 in June, DST)", () => {
    // Sanity that the helper is not Buenos-Aires-specific: Europe/Madrid is
    // UTC+2 in June, so 13:00 local is 11:00 UTC.
    const iso = resolveItemPublishAtIso(
      { ...slot, timezone: "Europe/Madrid" },
      "UTC",
    );
    expect(iso).toBe("2026-06-01T11:00:00.000Z");
  });

  it("refuses to schedule (returns null) on a non-IANA zone like 'ART'", () => {
    // V8's Intl accepts "ART" (-> GMT+3), so localDateTimeToUtcIso alone would
    // return a wrong-but-non-null instant. resolveItemPublishAtIso must return
    // null so the executor leaves the PostGroup as a draft instead of
    // publishing 6h off. runValidation also blocks this at draft time.
    expect(resolveItemPublishAtIso({ ...slot, timezone: "ART" }, "UTC")).toBeNull();
  });
});

describe("buildTimezoneSetupQuestion", () => {
  it("with a detected zone, builds a confirm question seeded with it", () => {
    const q = buildTimezoneSetupQuestion("America/Argentina/Buenos_Aires");
    expect(q.id).toBe("timezone_setup");
    expect(q.phase).toBe("foundational");
    expect(q.blocks_plan_until_resolved).toBe(true);
    expect(q.detected_timezone_iana).toBe("America/Argentina/Buenos_Aires");

    const payload = q.ask_user_question_payload as {
      header: string;
      options: Array<{ label: string; description: string }>;
    };
    expect(payload).not.toBeNull();
    expect(payload.header).toBe("Huso horario");
    expect(payload.options).toHaveLength(2);
    // Option 0 is the recommended, human-labelled detected zone.
    expect(payload.options[0]!.label).toContain("Buenos Aires");

    const actions = q.option_actions as Array<{
      option_index: number;
      next_action: string;
      timezone_iana?: string;
    }>;
    expect(actions[0]!.next_action).toBe("adopt_timezone");
    expect(actions[0]!.timezone_iana).toBe("America/Argentina/Buenos_Aires");
    expect(actions[1]!.next_action).toBe("ask_timezone_freeform");
  });

  it("with no detection signal, falls back to a freeform prose prompt", () => {
    const q = buildTimezoneSetupQuestion(null);
    expect(q.id).toBe("timezone_setup");
    expect(q.blocks_plan_until_resolved).toBe(true);
    expect(q.detected_timezone_iana).toBeNull();
    expect(q.ask_user_question_payload).toBeNull();
    expect(typeof q.freeform_prompt).toBe("string");
    expect((q.freeform_prompt as string).length).toBeGreaterThan(0);
  });
});
