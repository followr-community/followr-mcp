#!/usr/bin/env node
/**
 * Smoke test for spec validation (Phase 1 verification).
 *
 * Exercises the loader + pure validation function against a handful of
 * scenarios (valid, caption too long, mixed media, video too long, missing
 * required preference, Twitter verified bump, TikTok runtime override).
 *
 * Run: node scripts/smoke-test-specs.mjs
 */

import { getSpec, getSpecsMeta, listSpecKeys } from "../packages/mcp-core/dist/specs/loader.js";
import { validateAgainstSpec } from "../packages/mcp-core/dist/specs/validate.js";

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`    detail:`, detail);
  }
}

function section(name) {
  console.log(`\n[${name}]`);
}

// ───────────────────────────────────────────────────────────
section("Loader sanity");
const keys = listSpecKeys();
assert("15 spec keys present", keys.length === 15, keys);
assert(
  "instagram_feed exists",
  keys.includes("instagram_feed") && getSpec("instagram", "feed") !== null,
);
assert(
  "tiktok_feed exists",
  keys.includes("tiktok_feed") && getSpec("tiktok", "feed") !== null,
);
assert("medium_short missing (medium has no short)", getSpec("medium", "short") === null);
const meta = getSpecsMeta();
assert("meta.verified_at set", typeof meta?.verified_at === "string", meta);

// ───────────────────────────────────────────────────────────
section("Valid IG Feed post → no warnings");
{
  const w = validateAgainstSpec({
    network: "instagram",
    product_type: "feed",
    description: "A perfectly fine caption.",
    assets: [{ id: 1, type: "image", width: 1080, height: 1080, size_bytes: 500_000 }],
  });
  assert("no warnings", w.length === 0, w);
}

// ───────────────────────────────────────────────────────────
section("IG Feed caption over 2200 chars → 1 warning");
{
  const w = validateAgainstSpec({
    network: "instagram",
    product_type: "feed",
    description: "x".repeat(2500),
    assets: [{ id: 1, type: "image", width: 1080, height: 1080 }],
  });
  assert("exactly 1 warning", w.length === 1, w);
  assert("rule is max_length_exceeded", w[0]?.rule === "max_length_exceeded");
  assert("severity is hard_fail", w[0]?.severity === "hard_fail");
}

// ───────────────────────────────────────────────────────────
section("IG Feed mixed media (image + video) → no_mixed_media warning");
{
  const w = validateAgainstSpec({
    network: "instagram",
    product_type: "feed",
    description: "test",
    assets: [
      { id: 1, type: "image", width: 1080, height: 1080 },
      { id: 2, type: "video", width: 1080, height: 1920, duration_seconds: 30 },
    ],
  });
  const hasNoMixed = w.some((x) => x.rule === "no_mixed_media");
  assert("has no_mixed_media warning", hasNoMixed, w);
}

// ───────────────────────────────────────────────────────────
section("IG Reel video too long (1200s vs 900s max) → video_too_long");
{
  const w = validateAgainstSpec({
    network: "instagram",
    product_type: "reel",
    description: "test",
    assets: [{ id: 1, type: "video", width: 1080, height: 1920, duration_seconds: 1200 }],
  });
  const tooLong = w.find((x) => x.rule === "video_too_long");
  assert("has video_too_long warning", tooLong !== undefined, w);
  assert("expected = 900s", tooLong?.expected === 900);
}

// ───────────────────────────────────────────────────────────
section("TikTok without privacy_level → required warning");
{
  const w = validateAgainstSpec({
    network: "tiktok",
    product_type: "feed",
    description: "test",
    assets: [{ id: 1, type: "video", width: 1080, height: 1920, duration_seconds: 30 }],
  });
  const needsPrivacy = w.find((x) => x.field === "preferences.privacy_level");
  assert("has privacy_level required warning", needsPrivacy !== undefined, w);
}

// ───────────────────────────────────────────────────────────
section("Twitter caption 500 chars, unverified → exceeds 280");
{
  const w = validateAgainstSpec(
    {
      network: "twitter",
      product_type: "feed",
      description: "x".repeat(500),
    },
    { twitter_verified: false },
  );
  const exc = w.find((x) => x.rule === "max_length_exceeded");
  assert("caption exceeds (unverified)", exc !== undefined, w);
  assert("expected = 280", exc?.expected === 280);
  assert("suggestion mentions verified bump", exc?.suggestion?.includes("Premium") ?? false);
}

// ───────────────────────────────────────────────────────────
section("Twitter caption 500 chars, verified → under 25k limit, no warning");
{
  const w = validateAgainstSpec(
    {
      network: "twitter",
      product_type: "feed",
      description: "x".repeat(500),
    },
    { twitter_verified: true },
  );
  const exc = w.find((x) => x.rule === "max_length_exceeded");
  assert("no max_length warning when verified", exc === undefined, w);
}

// ───────────────────────────────────────────────────────────
section("TikTok video duration uses runtime context");
{
  // Static spec says 600s. Runtime context for account says 3600 (tier high).
  // Video is 1200s → should pass with runtime context, fail without.
  const wWithCtx = validateAgainstSpec(
    {
      network: "tiktok",
      product_type: "feed",
      description: "test",
      assets: [{ id: 1, type: "video", width: 1080, height: 1920, duration_seconds: 1200 }],
      preferences: { privacy_level: "PUBLIC_TO_EVERYONE" },
    },
    {
      tiktok_max_duration_seconds: 3600,
      tiktok_privacy_level_options: ["PUBLIC_TO_EVERYONE"],
    },
  );
  const tooLong = wWithCtx.find((x) => x.rule === "video_too_long");
  assert("1200s video OK with 3600s tier", tooLong === undefined, wWithCtx);

  const wNoCtx = validateAgainstSpec(
    {
      network: "tiktok",
      product_type: "feed",
      description: "test",
      assets: [{ id: 1, type: "video", width: 1080, height: 1920, duration_seconds: 1200 }],
      preferences: { privacy_level: "PUBLIC_TO_EVERYONE" },
    },
    {},
  );
  const tooLongNoCtx = wNoCtx.find((x) => x.rule === "video_too_long");
  assert("1200s video fails without runtime ctx (static 600s)", tooLongNoCtx !== undefined, wNoCtx);
}

// ───────────────────────────────────────────────────────────
section("IG Reel aspect ratio 1:1 (1.0) is outside [0.5, 1.91]? Wait, 1.0 is IN range");
{
  // IG Reel aspect_ratios is [0.5, 1.91]. 1.0 is in range, should pass.
  const w = validateAgainstSpec({
    network: "instagram",
    product_type: "reel",
    description: "test",
    assets: [{ id: 1, type: "video", width: 1080, height: 1080, duration_seconds: 30 }],
  });
  const aspect = w.find((x) => x.rule === "aspect_ratio_out_of_range");
  assert("1:1 video is allowed in IG Reel range [0.5, 1.91]", aspect === undefined, w);
}

// ───────────────────────────────────────────────────────────
section("YouTube Short with aspect 16:9 → outside [0.5, 0.625]");
{
  const w = validateAgainstSpec({
    network: "youtube",
    product_type: "short",
    title: "test",
    assets: [{ id: 1, type: "video", width: 1920, height: 1080, duration_seconds: 30 }],
  });
  const aspect = w.find((x) => x.rule === "aspect_ratio_out_of_range");
  assert("16:9 video flagged for YouTube Short", aspect !== undefined, w);
}

// ───────────────────────────────────────────────────────────
console.log(`\n────────────────────────────`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
