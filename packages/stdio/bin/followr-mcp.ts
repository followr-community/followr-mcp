#!/usr/bin/env node
// Followr MCP stdio binary.
// Launched by Claude Desktop / Claude Code / Cursor as a subprocess.
//
// Configuration is read from env vars:
//   FOLLOWR_API_TOKEN (required) - Your Followr API key. Generate at app.followr.ai by clicking
//     your profile picture (top-left) > API Keys, or visit app.followr.ai/settings/api-keys.
//     The env var name is historical; the value is your API key.
//   FOLLOWR_API_BASE_URL (optional, default: https://api.followr.ai) - Override for testing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FollowrClient } from "@followr-mcp/shared";
import { registerFollowrTools, FOLLOWR_SERVER_INSTRUCTIONS } from "@followr-mcp/mcp-core";
import pkg from "../package.json" with { type: "json" };

const token = process.env["FOLLOWR_API_TOKEN"];
if (!token) {
  console.error(
    [
      "Error: FOLLOWR_API_TOKEN env var is not set.",
      "",
      "Generate a Followr API key:",
      "  1. Go to https://app.followr.ai",
      "  2. Click your profile picture in the top-left",
      "  3. Select 'API Keys' from the dropdown (or open app.followr.ai/settings/api-keys)",
      "  4. Click 'Generate' and copy the value",
      "",
      "Then add it to your Claude Desktop config (or equivalent).",
      "Note: the env var name FOLLOWR_API_TOKEN is historical; the value is your API key.",
      '  "followr": {',
      '    "command": "npx",',
      '    "args": ["-y", "@followr/mcp"],',
      '    "env": { "FOLLOWR_API_TOKEN": "your_api_key_here" }',
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
    version: pkg.version,
  },
  {
    instructions: FOLLOWR_SERVER_INSTRUCTIONS,
  },
);

registerFollowrTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
