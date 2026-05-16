import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const src = resolve(repoRoot, "packages/mcp-core/src/data");
const dst = resolve(repoRoot, "packages/mcp-core/dist/data");

if (!existsSync(src)) {
  console.error(`copy-assets: source dir missing: ${src}`);
  process.exit(1);
}

cpSync(src, dst, { recursive: true, force: true });
console.log(`copy-assets: ${src} -> ${dst}`);
