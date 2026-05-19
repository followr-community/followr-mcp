#!/usr/bin/env node
// Followr MCP stdio binary.
// Launched by Claude Desktop / Claude Code / Cursor as a subprocess.
//
// Configuration is read from env vars:
//   FOLLOWR_API_TOKEN (required) - Generate at app.followr.ai > Company Settings > API Keys
//   FOLLOWR_API_BASE_URL (optional, default: https://api.followr.ai) - Override for testing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FollowrClient } from "@followr-mcp/shared";
import { registerFollowrTools, FOLLOWR_SERVER_INSTRUCTIONS } from "@followr-mcp/mcp-core";

const token = process.env["FOLLOWR_API_TOKEN"];
if (!token) {
  console.error(
    [
      "Error: FOLLOWR_API_TOKEN env var is not set.",
      "",
      "Generate a token in Followr:",
      "  1. Go to https://app.followr.ai",
      "  2. Settings > Company Settings > API Keys",
      "  3. Click 'Generate' and copy the value",
      "",
      "Then add it to your Claude Desktop config (or equivalent):",
      '  "followr": {',
      '    "command": "npx",',
      '    "args": ["-y", "@followr/mcp"],',
      '    "env": { "FOLLOWR_API_TOKEN": "your_token_here" }',
      "  }",
    ].join("\n"),
  );
  process.exit(1);
}

const baseUrl = process.env["FOLLOWR_API_BASE_URL"];

const client = new FollowrClient({
  token,
  ...(baseUrl ? { baseUrl } : {}),
});

const server = new McpServer(
  {
    name: "followr",
    version: "0.2.0",
  },
  {
    instructions: FOLLOWR_SERVER_INSTRUCTIONS,
  },
);

registerFollowrTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
