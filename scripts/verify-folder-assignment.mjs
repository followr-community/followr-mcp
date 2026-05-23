#!/usr/bin/env node
/**
 * Verify Gap Z14: PUT /api/assets/{id} with { folder_id } actually
 * reparents an asset under that folder, and the optional folder_id on
 * the create-asset POST body lands the new asset directly under that
 * folder without a follow-up PUT.
 *
 * Reads the bearer token from ~/.followr-token-test (gitignored,
 * local-only). Same convention as integration-test.mjs.
 *
 * The default target company is "Followr for MCP" (the workspace marked
 * for API verification per Marcos's memory). Override with TEST_COMPANY_ID
 * to use a different company.
 *
 * The script is destructive in the sense that it creates a temp folder
 * + asset (image type, placeholder only, NO binary uploaded) and DELETEs
 * them at the end. If a step fails mid-way, the cleanup block still
 * runs best-effort.
 *
 * Usage:
 *   node scripts/verify-folder-assignment.mjs
 *   TEST_COMPANY_ID=7 node scripts/verify-folder-assignment.mjs
 *
 * Token is read but never echoed to stdout.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const TOKEN_PATH = resolve(homedir(), ".followr-token-test");
const BASE_URL = process.env["FOLLOWR_API_BASE_URL"] ?? "https://api.followr.ai";
const TEST_COMPANY_NAME = "Followr for MCP";

let token = (process.env["FOLLOWR_API_TOKEN"] ?? "").trim();
if (!token) {
  try {
    token = readFileSync(TOKEN_PATH, "utf-8").trim();
  } catch {
    // fall through to error message below
  }
}
if (!token) {
  console.error(`No token available. Provide one of:`);
  console.error(`  - FOLLOWR_API_TOKEN env var: FOLLOWR_API_TOKEN=xxx node scripts/verify-folder-assignment.mjs`);
  console.error(`  - ${TOKEN_PATH} file (one line, no quotes)`);
  process.exit(1);
}

async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // non-JSON response (e.g. 204 with body, or HTML error page)
  }
  return { status: res.status, ok: res.ok, json, raw: text };
}

function check(label, cond, detail) {
  const icon = cond ? "✓" : "✗";
  console.log(`  ${icon} ${label}${detail ? `: ${detail}` : ""}`);
  return cond;
}

async function main() {
  console.log(`Base URL: ${BASE_URL}`);

  // ─── Pick target company ────────────────────────────────────────────────
  let companyId = process.env["TEST_COMPANY_ID"]
    ? parseInt(process.env["TEST_COMPANY_ID"], 10)
    : null;
  if (!companyId) {
    console.log(`\n1. Resolve company "${TEST_COMPANY_NAME}"`);
    const listRes = await api("GET", "/api/companies?page[size]=100");
    if (!listRes.ok) {
      console.error(`  FAIL list_companies HTTP ${listRes.status}: ${listRes.raw.slice(0, 300)}`);
      process.exit(1);
    }
    const companies = listRes.json?.data ?? [];
    const match = companies.find((c) => c.name === TEST_COMPANY_NAME);
    if (!match) {
      console.error(`  FAIL: company "${TEST_COMPANY_NAME}" not in your accessible companies.`);
      console.error(`  Override with TEST_COMPANY_ID env var.`);
      process.exit(1);
    }
    companyId = match.id;
    console.log(`  using company "${match.name}" (id ${match.id})`);
  } else {
    console.log(`\n1. Using TEST_COMPANY_ID=${companyId}`);
  }

  // ─── Step 2: create test folder ────────────────────────────────────────
  console.log(`\n2. Create test folder`);
  const folderName = `_verify-Z14-${Date.now()}`;
  const folderRes = await api("POST", `/api/companies/${companyId}/folders`, {
    name: folderName,
  });
  if (!folderRes.ok || !folderRes.json?.data?.id) {
    console.error(`  FAIL HTTP ${folderRes.status}: ${folderRes.raw.slice(0, 300)}`);
    process.exit(1);
  }
  const folderId = folderRes.json.data.id;
  console.log(`  created folder "${folderName}" (id ${folderId})`);

  let assetIdA = null; // asset created at root, moved later via PUT
  let assetIdB = null; // asset created directly with folder_id in POST body

  try {
    // ─── Step 3: create asset at root ────────────────────────────────────
    console.log(`\n3. Create asset placeholder at company root`);
    const assetARes = await api("POST", `/api/companies/${companyId}/assets`, {
      name: `verify-Z14-root-${Date.now()}.png`,
      type: "image",
    });
    if (!assetARes.ok || !assetARes.json?.data?.id) {
      console.error(`  FAIL HTTP ${assetARes.status}: ${assetARes.raw.slice(0, 300)}`);
      process.exit(1);
    }
    assetIdA = assetARes.json.data.id;
    const assetAFolderInResp = assetARes.json.data.folder_id;
    console.log(`  created asset id ${assetIdA}`);
    check(
      "create response includes folder_id field",
      assetAFolderInResp !== undefined,
      `value=${JSON.stringify(assetAFolderInResp)}`,
    );

    // ─── Step 4: PUT folder_id on the asset ─────────────────────────────
    console.log(`\n4. PUT /api/assets/${assetIdA} with { folder_id: ${folderId} }`);
    const putRes = await api("PUT", `/api/assets/${assetIdA}`, {
      folder_id: folderId,
    });
    const putOk = check(
      `PUT returned 2xx`,
      putRes.ok,
      `HTTP ${putRes.status}`,
    );
    if (!putOk) {
      console.log(`  body (first 400 chars): ${putRes.raw.slice(0, 400)}`);
    } else {
      const putFolderIdInResp = putRes.json?.data?.folder_id;
      check(
        `PUT response folder_id matches`,
        putFolderIdInResp === folderId,
        `got ${JSON.stringify(putFolderIdInResp)}`,
      );
    }

    // ─── Step 5: GET the asset to verify folder_id stuck ────────────────
    console.log(`\n5. GET /api/assets/${assetIdA} (does the asset really live in the folder?)`);
    const getRes = await api("GET", `/api/assets/${assetIdA}`);
    if (getRes.ok && getRes.json?.data) {
      const persistedFolderId = getRes.json.data.folder_id;
      check(
        `GET response folder_id matches`,
        persistedFolderId === folderId,
        `got ${JSON.stringify(persistedFolderId)}`,
      );
    } else {
      check(`GET returned 2xx`, false, `HTTP ${getRes.status} — ${getRes.raw.slice(0, 200)}`);
    }

    // ─── Step 6: list assets filtered by folder_id ──────────────────────
    console.log(`\n6. GET /api/companies/${companyId}/assets?filter[folder_id]=${folderId}`);
    const listFilteredRes = await api(
      "GET",
      `/api/companies/${companyId}/assets?filter[folder_id]=${folderId}&page[size]=20`,
    );
    if (listFilteredRes.ok) {
      const ids = (listFilteredRes.json?.data ?? []).map((a) => a.id);
      check(
        `filtered list contains the moved asset`,
        ids.includes(assetIdA),
        `ids returned: [${ids.join(", ")}]`,
      );
    } else {
      check(`filtered list returned 2xx`, false, `HTTP ${listFilteredRes.status}`);
    }

    // ─── Step 7: create asset DIRECTLY in folder (folder_id in POST body) ─
    console.log(`\n7. POST /api/companies/${companyId}/assets with folder_id in body`);
    const assetBRes = await api("POST", `/api/companies/${companyId}/assets`, {
      name: `verify-Z14-direct-${Date.now()}.png`,
      type: "image",
      folder_id: folderId,
    });
    if (assetBRes.ok && assetBRes.json?.data?.id) {
      assetIdB = assetBRes.json.data.id;
      const directFolderId = assetBRes.json.data.folder_id;
      check(
        `create-with-folder returned 2xx`,
        true,
        `asset id ${assetIdB}`,
      );
      check(
        `create response folder_id matches the one we sent`,
        directFolderId === folderId,
        `got ${JSON.stringify(directFolderId)}`,
      );
    } else {
      check(
        `create-with-folder returned 2xx`,
        false,
        `HTTP ${assetBRes.status} — ${assetBRes.raw.slice(0, 200)}`,
      );
    }

    // ─── Step 8: PUT folder_id=null to detach ───────────────────────────
    console.log(`\n8. PUT /api/assets/${assetIdA} with { folder_id: null } (detach)`);
    const detachRes = await api("PUT", `/api/assets/${assetIdA}`, {
      folder_id: null,
    });
    if (detachRes.ok) {
      const detachedFolderId = detachRes.json?.data?.folder_id;
      check(
        `PUT with null returned 2xx`,
        true,
        `folder_id in response=${JSON.stringify(detachedFolderId)}`,
      );
    } else {
      check(
        `PUT with null returned 2xx`,
        false,
        `HTTP ${detachRes.status} — ${detachRes.raw.slice(0, 200)}`,
      );
    }
  } finally {
    // ─── Cleanup ───────────────────────────────────────────────────────
    console.log(`\n9. Cleanup`);
    if (assetIdA !== null) {
      const r = await api("DELETE", `/api/assets/${assetIdA}`);
      console.log(`  delete asset ${assetIdA}: HTTP ${r.status}`);
    }
    if (assetIdB !== null) {
      const r = await api("DELETE", `/api/assets/${assetIdB}`);
      console.log(`  delete asset ${assetIdB}: HTTP ${r.status}`);
    }
    const f = await api("DELETE", `/api/folders/${folderId}`);
    console.log(`  delete folder ${folderId}: HTTP ${f.status}`);
  }

  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(`\nUnhandled error: ${err.message}`);
  process.exit(1);
});
