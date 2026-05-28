#!/usr/bin/env node
/**
 * Cleanup orphaned "phantom" assets in a Followr company's library.
 *
 * Context: when the 3-step asset upload pattern (create placeholder ->
 * request presigned URL -> PUT bytes to Azure) fails at step 2 or 3, the
 * placeholder created in step 1 remains in the library forever as a
 * phantom row (entry exists, no bytes attached). The MCP's uploadFromUrl
 * now auto-cleans these (see assets.ts cleanupPhantomPlaceholder), but
 * historical phantoms accumulated before that fix remain. This script
 * scrubs them.
 *
 * Heuristic for "phantom":
 *   - assets that share the exact same name as another (probable
 *     duplicate from an uploadFromUrl retry).
 *
 * For each duplicate group, the script keeps the NEWEST entry (highest
 * id, since ids are monotonically assigned in Followr) and proposes the
 * rest for deletion. The user reviews the proposed list and confirms
 * before any DELETE call runs.
 *
 * Token: read from FOLLOWR_API_TOKEN env var, or from
 * ~/.followr-token-test (single line). Never echoed.
 *
 * Usage:
 *   node scripts/cleanup-phantom-assets.mjs --company-id 42129
 *   FOLLOWR_API_TOKEN=xxx node scripts/cleanup-phantom-assets.mjs --company-id 42129
 *   node scripts/cleanup-phantom-assets.mjs --company-id 42129 --dry-run
 *   node scripts/cleanup-phantom-assets.mjs --company-id 42129 --type video
 *   node scripts/cleanup-phantom-assets.mjs --company-id 42129 --yes (skip confirmation)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const TOKEN_PATH = resolve(homedir(), ".followr-token-test");
const BASE_URL = process.env["FOLLOWR_API_BASE_URL"] ?? "https://api.followr.ai";

function parseArgs(argv) {
  const args = { companyId: null, type: null, dryRun: false, yes: false, pageSize: 100 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--company-id" || arg === "--companyId") {
      args.companyId = Number(argv[++i]);
    } else if (arg === "--type") {
      args.type = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      args.yes = true;
    } else if (arg === "--page-size") {
      args.pageSize = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`cleanup-phantom-assets.mjs - scrub duplicate/phantom assets in a Followr company library

Required:
  --company-id <id>     Followr company id to scan

Optional:
  --type <kind>         Filter by asset type: image | video | audio (default: all)
  --dry-run             List candidates but DO NOT delete
  --yes, -y             Skip interactive confirmation (CI / scripted use)
  --page-size <n>       Page size for the list call (default 100, max 100)
  --help, -h            This message

Token: FOLLOWR_API_TOKEN env var OR ~/.followr-token-test (single line, no quotes)
`);
}

function loadToken() {
  let token = (process.env["FOLLOWR_API_TOKEN"] ?? "").trim();
  if (!token) {
    try {
      token = readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {
      // fall through
    }
  }
  if (!token) {
    console.error(
      `No token. Set FOLLOWR_API_TOKEN env var or write the token to ${TOKEN_PATH} (single line).`,
    );
    process.exit(1);
  }
  return token;
}

async function api(token, method, path, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} failed: HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  return res.json();
}

async function listAllAssets(token, companyId, type, pageSize) {
  const out = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams();
    query.set("page[size]", String(pageSize));
    query.set("page[number]", String(page));
    if (type) query.set("filter[type]", type);
    const path = `/api/companies/${companyId}/assets?${query.toString()}`;
    const body = await api(token, "GET", path);
    const items = Array.isArray(body?.data) ? body.data : [];
    out.push(...items);
    if (items.length < pageSize) break;
    if (page > 50) break; // safety cap
  }
  return out;
}

function groupByName(assets) {
  const groups = new Map();
  for (const a of assets) {
    const key = (a.name ?? "").trim();
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(a);
    groups.set(key, arr);
  }
  return groups;
}

function buildDeletionPlan(groups) {
  // For each group of >1, keep the newest (highest id) and propose the
  // rest for deletion. Highest id is the most-recently-created entry in
  // Followr; the older entries are the phantoms from prior failed retries.
  const toDelete = [];
  for (const [name, items] of groups) {
    if (items.length <= 1) continue;
    const sorted = [...items].sort((a, b) => b.id - a.id);
    const [keep, ...drop] = sorted;
    for (const d of drop) {
      toDelete.push({ ...d, group_name: name, keep_id: keep.id });
    }
  }
  toDelete.sort((a, b) => a.id - b.id);
  return toDelete;
}

async function confirm(prompt) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`${prompt} `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.companyId || !Number.isFinite(args.companyId)) {
    console.error("--company-id is required (numeric).");
    printHelp();
    process.exit(1);
  }
  const token = loadToken();

  console.log(`Scanning company ${args.companyId}${args.type ? ` (type=${args.type})` : ""}...`);
  const assets = await listAllAssets(token, args.companyId, args.type, args.pageSize);
  console.log(`Found ${assets.length} asset(s) total.`);

  const groups = groupByName(assets);
  const duplicates = [...groups.values()].filter((g) => g.length > 1);
  console.log(`Duplicate-name groups: ${duplicates.length}`);

  const plan = buildDeletionPlan(groups);
  if (plan.length === 0) {
    console.log("No phantom candidates found. Library looks clean.");
    return;
  }

  console.log(`\nProposed deletions (${plan.length}):`);
  for (const item of plan) {
    console.log(
      `  - id=${item.id}  type=${item.type}  name="${item.name}"  (group keeps newer id=${item.keep_id})`,
    );
  }

  if (args.dryRun) {
    console.log("\n--dry-run set; nothing was deleted.");
    return;
  }

  if (!args.yes) {
    const ok = await confirm(`\nDelete ${plan.length} asset(s)? [y/N]`);
    if (!ok) {
      console.log("Aborted; nothing was deleted.");
      return;
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const item of plan) {
    try {
      await api(token, "DELETE", `/api/assets/${item.id}`);
      deleted += 1;
      console.log(`  ok   id=${item.id}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL id=${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nDeleted ${deleted} / Failed ${failed}.`);
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
