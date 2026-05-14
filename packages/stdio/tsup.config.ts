// tsup bundle config for the @followr/mcp stdio binary.
//
// Why bundle: the source imports workspace packages (@followr-mcp/shared,
// @followr-mcp/mcp-core) which are NOT published to npm. tsup inlines them
// into a single self-contained binary so the published tarball works for
// any consumer without needing the monorepo on disk.
//
// External deps: only the real npm packages that the user's environment
// is expected to resolve via npm install (peer-like behavior, allows dedup
// when the consumer already has them).

import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "followr-mcp": "bin/followr-mcp.ts" },
  outDir: "dist/bin",
  format: ["esm"],
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false, // CLI binary, no need to expose types
  shims: false,
  // These npm packages stay as runtime deps in package.json; tsup leaves
  // their imports untouched so npm install resolves them in the consumer.
  external: ["@modelcontextprotocol/sdk", "zod"],
  // The source file `bin/followr-mcp.ts` already starts with a shebang.
  // tsup/esbuild preserves it in the bundled output and chmod +x is applied
  // automatically, so the file is directly executable as the `followr-mcp`
  // bin npm symlinks.
});
