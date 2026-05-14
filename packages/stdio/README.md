# @followr/mcp

MCP server for Followr. Connects Claude (and any MCP-compatible AI agent) to your Followr workspace.

**Status:** v0.1 alpha. Surface is growing rapidly. See repo for roadmap.

## Install

In your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "followr": {
      "command": "npx",
      "args": ["-y", "@followr/mcp"],
      "env": {
        "FOLLOWR_API_TOKEN": "your_followr_api_token_here"
      }
    }
  }
}
```

Restart Claude Desktop. The `followr` connector should appear in the connectors panel.

For Claude Code:

```bash
claude mcp add followr "npx -y @followr/mcp" --env FOLLOWR_API_TOKEN=your_token
```

For Cursor: similar, via the MCP servers config UI.

## Generate your API token

1. Go to https://app.followr.ai
2. Settings > Company Settings > API Keys
3. Click "Generate" and copy the value
4. Paste it in your Claude Desktop config

## What you can ask Claude

- "Show me pending drafts in my Acme workspace"
- "Generate 5 viral shorts about productivity for this week"
- "Take this blog post URL and create posts for Twitter, Instagram, LinkedIn scheduled for Monday"
- "Approve draft 1234"
- "List unread DMs across Facebook and Instagram"

## Repository

Source code, full tool list, and roadmap: https://github.com/marcosplaza/followr-mcp (TODO: replace with actual repo URL when published)

## License

MIT
