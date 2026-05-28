// Vitest root config. Workspaces are discovered automatically via include
// patterns. Tests live alongside source in `packages/*/src/**/*.test.ts`.
//
// Why not vitest workspaces (vitest.workspace.ts):
//   The monorepo uses tsconfig project references and the test files import
//   from sibling packages via the workspace alias. A single root config with
//   include globs is simpler than splitting per-package and avoids the
//   need to maintain N config files for what is effectively one TS project.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**"],
    environment: "node",
    pool: "threads",
    reporters: ["default"],
    typecheck: {
      enabled: false,
    },
  },
});
