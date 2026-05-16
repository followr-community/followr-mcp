#!/usr/bin/env node
/**
 * Integration test — runs the new stdio binary against the real Followr API.
 *
 * Reads FOLLOWR_API_TOKEN from ~/.followr-token-test (gitignored, local-only).
 * Test target PostGroup id must be passed as TEST_POST_GROUP_ID env var.
 *
 * Verifies:
 *   1. validate_against_specs against TikTok in company 7 returns a non-empty
 *      runtime_context (proves the real Followr API call worked)
 *   2. create_post creates a real Post inside the target PostGroup and returns
 *      the new post id with no spec warnings (because the payload is valid)
 *
 * Token is read but never echoed to stdout.
 *
 * Usage:
 *   TEST_POST_GROUP_ID=709047 node scripts/integration-test.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BINARY_PATH = resolve(REPO_ROOT, "packages/stdio/dist/bin/followr-mcp.js");
const TOKEN_PATH = resolve(homedir(), ".followr-token-test");

const POST_GROUP_ID = parseInt(process.env["TEST_POST_GROUP_ID"] ?? "0", 10);
if (!POST_GROUP_ID) {
  console.error("Set TEST_POST_GROUP_ID env var");
  process.exit(1);
}

let token;
try {
  token = readFileSync(TOKEN_PATH, "utf-8").trim();
  if (!token) throw new Error("empty");
} catch (e) {
  console.error(`Cannot read token from ${TOKEN_PATH}: ${e.message}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`    detail:`, JSON.stringify(detail).slice(0, 800));
  }
}

const TIMEOUT_MS = 30_000;

async function main() {
  console.log(`Binary: ${BINARY_PATH}`);
  console.log(`Token: <${token.length} chars, masked>`);
  console.log(`Test PostGroup: ${POST_GROUP_ID}`);

  const proc = spawn("node", [BINARY_PATH], {
    env: { ...process.env, FOLLOWR_API_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  const pending = new Map();
  let buffer = "";
  proc.stdout.on("data", (d) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id).resolve(msg);
          pending.delete(msg.id);
        }
      } catch {}
    }
  });

  function send(method, params, id) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout: ${method} (id=${id})`));
        }
      }, TIMEOUT_MS);
    });
  }

  let postIdToReport = null;
  try {
    // 1. Initialize
    const initResp = await send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0" },
      },
      1,
    );
    assert("initialize OK", initResp.result?.serverInfo?.name === "followr");
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    // 2. validate_against_specs for TikTok — should populate runtime_context from real API
    console.log("\n[validate_against_specs — TikTok with real runtime context]");
    const validResp = await send(
      "tools/call",
      {
        name: "validate_against_specs",
        arguments: {
          company_id: 7,
          network: "tiktok",
          product_type: "feed",
          description: "test caption",
          assets: [
            {
              id: 999,
              type: "video",
              width: 1080,
              height: 1920,
              duration_seconds: 1200,
            },
          ],
          preferences: { privacy_level: "PUBLIC_TO_EVERYONE" },
        },
      },
      2,
    );
    const validParsed = JSON.parse(validResp.result?.content?.[0]?.text ?? "{}");
    assert(
      "runtime_context populated (real API call succeeded)",
      validParsed.runtime_context?.tiktok_max_duration_seconds != null,
      validParsed.runtime_context,
    );
    assert(
      "tiktok_max_duration_seconds = 3600 (from connected account)",
      validParsed.runtime_context?.tiktok_max_duration_seconds === 3600,
    );
    assert(
      "privacy_level_options array fetched",
      Array.isArray(validParsed.runtime_context?.tiktok_privacy_level_options) &&
        validParsed.runtime_context.tiktok_privacy_level_options.length > 0,
    );
    assert(
      "1200s video OK with 3600s tier (no video_too_long warning)",
      !validParsed.warnings?.some((w) => w.rule === "video_too_long"),
      validParsed.warnings,
    );

    // 3. create_post — actual API call to Followr that creates a real Post
    console.log("\n[create_post — instagram into test PostGroup]");
    const createResp = await send(
      "tools/call",
      {
        name: "create_post",
        arguments: {
          post_group_id: POST_GROUP_ID,
          company_id: 7,
          social_network_type: "instagram",
          product_type: "feed",
          description:
            "Integration test — auto-created by followr-mcp smoke test. Will be deleted seconds later. Ignore.",
        },
      },
      3,
    );
    const createText = createResp.result?.content?.[0]?.text;
    assert("create_post returned content", typeof createText === "string", createResp);

    if (typeof createText === "string") {
      const parsed = JSON.parse(createText);
      const post = parsed.post?.data ?? parsed.post;
      assert("post object returned", post != null, parsed);
      assert("post.id is a number", typeof post?.id === "number", post);
      postIdToReport = post?.id ?? null;
      assert(
        "validation.warnings is array",
        Array.isArray(parsed.validation?.warnings),
        parsed.validation,
      );
      assert(
        "no warnings (valid IG payload)",
        parsed.validation?.warning_count === 0,
        parsed.validation?.warnings,
      );
    }
  } finally {
    proc.kill();
  }

  if (stderr) {
    console.log(`\n[stderr from server]`);
    console.log(stderr.slice(0, 1500));
  }

  console.log(`\n────────────────────────────`);
  if (postIdToReport) {
    console.log(`Created Post id: ${postIdToReport} (inside PostGroup ${POST_GROUP_ID})`);
  }
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
