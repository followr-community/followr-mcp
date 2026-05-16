#!/usr/bin/env node
/**
 * Protocol smoke test for the stdio MCP binary.
 *
 * Spawns packages/stdio/dist/bin/followr-mcp.js, sends MCP JSON-RPC messages
 * via stdin, verifies tool registration + a sample validate_against_specs call.
 *
 * Does NOT make real Followr API calls (gatherRuntimeContext fails open with
 * an invalid token, validation falls back to static defaults).
 *
 * Run: node scripts/smoke-test-mcp-protocol.mjs
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BINARY_PATH = resolve(REPO_ROOT, "packages/stdio/dist/bin/followr-mcp.js");

const TIMEOUT_MS = 15_000;

let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`    detail:`, JSON.stringify(detail).slice(0, 500));
  }
}

async function main() {
  console.log(`Spawning ${BINARY_PATH}...`);
  const proc = spawn("node", [BINARY_PATH], {
    env: {
      ...process.env,
      FOLLOWR_API_TOKEN: "smoketest|protocol-test-no-real-calls",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Collect stderr for diagnostics
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  // Parse stdout line-by-line for JSON-RPC messages
  const pending = new Map(); // id → { resolve }
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
      } catch {
        // ignore non-JSON output
      }
    }
  });

  function send(method, params, id) {
    const msg = { jsonrpc: "2.0", id, method, params };
    proc.stdin.write(JSON.stringify(msg) + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
        }
      }, TIMEOUT_MS);
    });
  }

  try {
    // ─────────────────────────────────────────────
    console.log("\n[1. initialize]");
    const initResp = await send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0" },
      },
      1,
    );
    assert("initialize returns serverInfo", initResp.result?.serverInfo != null, initResp);
    assert("server name is 'followr'", initResp.result?.serverInfo?.name === "followr", initResp.result?.serverInfo);
    const serverVersion = initResp.result?.serverInfo?.version;
    console.log(`  server version: ${serverVersion}`);

    // Send initialized notification (no response expected)
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    // ─────────────────────────────────────────────
    console.log("\n[2. tools/list]");
    const listResp = await send("tools/list", {}, 2);
    const tools = listResp.result?.tools ?? [];
    assert(`tools/list returns array (got ${tools.length})`, tools.length > 0);

    const toolNames = tools.map((t) => t.name);
    assert(
      "create_post tool registered",
      toolNames.includes("create_post"),
      toolNames.filter((n) => n.includes("post")).slice(0, 5),
    );
    assert(
      "validate_against_specs tool registered",
      toolNames.includes("validate_against_specs"),
      toolNames.filter((n) => n.includes("valid")).slice(0, 5),
    );

    // Verify schemas
    const createPost = tools.find((t) => t.name === "create_post");
    const validateTool = tools.find((t) => t.name === "validate_against_specs");

    if (createPost) {
      const props = createPost.inputSchema?.properties ?? {};
      const required = createPost.inputSchema?.required ?? [];
      assert("create_post has post_group_id (required)", "post_group_id" in props && required.includes("post_group_id"));
      assert("create_post has company_id (required)", "company_id" in props && required.includes("company_id"));
      assert("create_post has social_network_type (required)", "social_network_type" in props && required.includes("social_network_type"));
      assert("create_post has product_type (required)", "product_type" in props && required.includes("product_type"));
      assert("create_post has assets (optional)", "assets" in props);
      assert("create_post has preferences (optional)", "preferences" in props);
    }

    if (validateTool) {
      const props = validateTool.inputSchema?.properties ?? {};
      assert("validate_against_specs has company_id", "company_id" in props);
      assert("validate_against_specs has network", "network" in props);
      assert("validate_against_specs has product_type", "product_type" in props);
    }

    // ─────────────────────────────────────────────
    console.log("\n[3. tools/call validate_against_specs — IG Feed valid post]");
    const callResp = await send(
      "tools/call",
      {
        name: "validate_against_specs",
        arguments: {
          company_id: 7,
          network: "instagram",
          product_type: "feed",
          description: "A valid caption under 2200 chars.",
          assets: [{ id: 999, type: "image", width: 1080, height: 1080, size_bytes: 500_000 }],
        },
      },
      3,
    );
    const respText = callResp.result?.content?.[0]?.text;
    assert("tools/call returned content", typeof respText === "string", callResp);

    if (typeof respText === "string") {
      const parsed = JSON.parse(respText);
      assert("response has spec_key", parsed.spec_key === "instagram_feed");
      assert("response has spec_exists=true", parsed.spec_exists === true);
      assert("warnings is array", Array.isArray(parsed.warnings));
      assert("valid post → 0 warnings", parsed.warning_count === 0, parsed.warnings);
      assert("runtime_context returned (object)", typeof parsed.runtime_context === "object");
      assert("specs_verified_at present", typeof parsed.specs_verified_at === "string");
    }

    // ─────────────────────────────────────────────
    console.log("\n[4. tools/call validate_against_specs — IG Feed caption too long]");
    const callResp2 = await send(
      "tools/call",
      {
        name: "validate_against_specs",
        arguments: {
          company_id: 7,
          network: "instagram",
          product_type: "feed",
          description: "x".repeat(2500),
          assets: [{ id: 999, type: "image", width: 1080, height: 1080 }],
        },
      },
      4,
    );
    const respText2 = callResp2.result?.content?.[0]?.text;
    if (typeof respText2 === "string") {
      const parsed = JSON.parse(respText2);
      assert("over-long caption → 1 warning", parsed.warning_count === 1, parsed.warnings);
      assert(
        "warning rule is max_length_exceeded",
        parsed.warnings?.[0]?.rule === "max_length_exceeded",
      );
    }

    // ─────────────────────────────────────────────
    console.log("\n[5. tools/call validate_against_specs — TikTok no privacy_level]");
    const callResp3 = await send(
      "tools/call",
      {
        name: "validate_against_specs",
        arguments: {
          company_id: 7,
          network: "tiktok",
          product_type: "feed",
          description: "test",
          assets: [{ id: 999, type: "video", width: 1080, height: 1920, duration_seconds: 30 }],
        },
      },
      5,
    );
    const respText3 = callResp3.result?.content?.[0]?.text;
    if (typeof respText3 === "string") {
      const parsed = JSON.parse(respText3);
      const hasPrivacy = parsed.warnings?.some((w) => w.field === "preferences.privacy_level");
      assert("TikTok without privacy_level → warning", hasPrivacy === true, parsed.warnings);
    }
  } finally {
    proc.kill();
  }

  if (stderr) {
    console.log(`\n[stderr from server, for diagnostics]`);
    console.log(stderr.slice(0, 2000));
  }

  console.log(`\n────────────────────────────`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
