#!/usr/bin/env node
// Typecheck runner that works with project references.
//
// Why this exists: `tsc --build ... --noEmit` is rejected by TypeScript because
// referenced projects with `composite: true` (required by project references)
// cannot disable emit. We work around that here by running a real build
// (which IS a typecheck), then deleting the emitted artifacts so the working
// tree stays clean. Exit code propagates from tsc so this fails loud in CI.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const PACKAGES = [
  "packages/shared",
  "packages/mcp-core",
  "packages/stdio",
  "packages/worker",
];

const build = spawnSync("npx", ["tsc", "--build", ...PACKAGES], { stdio: "inherit" });
const exitCode = build.status ?? 1;

for (const pkg of PACKAGES) {
  rmSync(`${pkg}/dist`, { recursive: true, force: true });
  rmSync(`${pkg}/tsconfig.tsbuildinfo`, { force: true });
}

process.exit(exitCode);
