# @followr/mcp

> **UNOFFICIAL.** Community project maintained by Followr Community Maintainers.
> Not endorsed by, affiliated with, or supported by Followr Inc.
> For official Followr support, contact support@followr.ai.

Model Context Protocol (MCP) server for [Followr](https://followr.ai). Connect
Claude Desktop, Claude Code, Cursor, or any MCP-compatible AI client to your
Followr workspace and operate it from natural language: schedule posts, generate
content with AI, manage avatars and lipsync videos, run automations, triage the
social inbox, and more.

**Status:** v0.1 alpha. API surface is stabilizing; expect occasional changes
between minor versions until v1.0.

## What you can ask Claude after installing

- "Show me the pending drafts in my Acme workspace."
- "Generate 5 short Instagram caption ideas about [topic] for workspace [name]."
- "Take this blog post URL and adapt it into one post per network for X, LinkedIn, and Instagram, saved as drafts."
- "List all unread DMs across my Facebook and Instagram accounts."
- "Create a short avatar video with [avatar name] saying [script] for Instagram Reels."

The MCP exposes 67 tools, 6 resources, and 5 canned workflows. Source code and
full tool list at https://github.com/followr-community/followr-mcp.

## Before you start

1. **A computer** (macOS, Windows, or Linux).
2. **Node.js 20 or newer.** Check with `node --version`; if missing, install LTS from https://nodejs.org.
3. **An MCP-compatible AI client.** Pick one:
   - Claude Desktop: https://claude.ai/download (recommended, GUI).
   - Claude Code: https://docs.claude.com/en/docs/claude-code (CLI).
   - Cursor: https://cursor.com (IDE with chat).
4. **An active Followr account.**

## Step 1: Generate a Followr API token

1. Sign in at https://app.followr.ai.
2. Top bar: pick the workspace you want the AI to operate in.
3. Click the gear icon to its right → **API Keys** in the sidebar.
4. Click **Generate**, name it something memorable (e.g. "Claude MCP").
5. **Copy the token immediately.** Followr only shows it once.

> ⚠️ **Security:** the token is a credential. Treat it like a password.
> Never paste it in a chat (Claude, Slack, anywhere). Only paste it into your
> terminal or your local config file. If it leaks, revoke it in the same UI
> and generate a new one.

> ⚠️ **Followr tokens contain a `|` (pipe) character** in the middle.
> The pipe is a special shell character. In every command below, the token
> goes inside **single quotes** (`'...'`) so the shell does not split it.
> If you forget the quotes, only the part before the `|` gets stored and
> every request returns 401.

## Step 2: Configure your AI client

### Option A — Claude Desktop (recommended)

Open the config file (create with `{}` as content if missing):

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Add the Followr connector inside `mcpServers`. If your file is `{}`, replace it with:

```json
{
  "mcpServers": {
    "followr": {
      "command": "npx",
      "args": ["-y", "@followr/mcp"],
      "env": {
        "FOLLOWR_API_TOKEN": "PASTE_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

If you already have other MCPs, keep them and add `"followr"` as a sibling:

```json
{
  "mcpServers": {
    "your-existing-mcp": { "...": "..." },
    "followr": {
      "command": "npx",
      "args": ["-y", "@followr/mcp"],
      "env": {
        "FOLLOWR_API_TOKEN": "PASTE_YOUR_TOKEN_HERE"
      }
    }
  }
}
```

The token goes inside the JSON string literal as-is (no shell quoting needed inside JSON).

Save the file, **fully quit Claude Desktop** (Cmd+Q on macOS, no minimizing), and reopen it. First launch with Followr added takes ~5 to 10 seconds extra to download the package; one-time and cached afterward.

### Option B — Claude Code (CLI)

In your terminal, register the MCP at user scope so it is available in every project:

```bash
claude mcp add --scope user followr --env 'FOLLOWR_API_TOKEN=PASTE_YOUR_TOKEN_HERE' -- npx -y @followr/mcp
```

> Note: the **single quotes** around `FOLLOWR_API_TOKEN=...` protect the `|` in your token from the shell. Required.
> Note: `--scope user` makes it available in every project. Without it, the MCP would only show up in sessions started from the current directory.
> Note: the `--` before `npx` separates Claude CLI's own arguments from the MCP command.

Verify:

```bash
claude mcp get followr
```

Look for `Scope: User config` and `Status: ✓ Connected`. Open a new Claude Code session (existing sessions do not reload MCP config) and try a prompt.

### Option C — Cursor

Edit `~/.cursor/mcp.json` (or `%USERPROFILE%\.cursor\mcp.json` on Windows). Use the same JSON shape as Claude Desktop. Restart Cursor.

## Step 3: Verify it works

In a new chat, send:

> Use the Followr MCP to show me which user my API token belongs to.

Expected response: your name, timezone, language, current credits. If you see that, you are connected.

## Troubleshooting

**"Failed to connect" right after registering.**

Run `claude mcp get followr` and check the `Environment:` section. If `FOLLOWR_API_TOKEN` shows only the first part of your token (e.g. `220248` without the `|...` after it), the shell split your command. Re-add with single quotes around the env var:

```bash
claude mcp remove followr
claude mcp add --scope user followr --env 'FOLLOWR_API_TOKEN=YOUR_FULL_TOKEN' -- npx -y @followr/mcp
```

**The MCP is registered but my AI client says it does not see it.**

Verify the scope. `claude mcp get followr` should show `Scope: User config (private to you across all projects)`. If it says `Scope: Local config (private to you in this project)`, the MCP is only available in sessions opened from the directory where you ran `claude mcp add`. Remove and re-add with `--scope user`.

For Claude Desktop and Cursor, fully quit and reopen the app (do not just close the window).

**"Command 'npx' not found."**

Node.js is not installed or not on your PATH. Install LTS from https://nodejs.org, then restart your terminal and your AI client.

**"401 Unauthorized" on every tool call.**

The token is invalid or revoked. Generate a new one in Followr (Settings → API Keys → Generate), update the value in your config (or via `claude mcp remove followr` + re-add), and restart your client.

**"This user does not belong to the company provided."**

You asked the AI to operate on a workspace your token has no access to. Ask Claude to list your workspaces first and pick one you own or are a member of.

**"Your current subscription does not include the necessary features to perform this action."**

The specific workspace does not have the AI add-on enabled. Try a workspace on the full plan, or upgrade the workspace's plan in Followr.

**First call to the MCP feels slow.**

That is `npx` downloading the package and its runtime dependencies (~25 MB cached in `~/.npm/_npx/`). One-time. Subsequent launches are immediate. Pre-warm if you want:

```bash
npx -y @followr/mcp --version || true
```

(Ignore the output; the cache is now warm.)

## Security and privacy

- The MCP runs as a local subprocess of your AI client. It is not a hosted service.
- Your Followr token never leaves your computer except in HTTPS requests directly to `api.followr.ai`.
- The token only unlocks the workspaces you already have access to in Followr.
- No telemetry. The MCP does not phone home.
- Source code is open and auditable: https://github.com/followr-community/followr-mcp.
- To revoke a leaked token: Followr → Settings → API Keys → delete.

## What's not in v0.1

- Remote HTTP transport (planned for v0.2). Today the MCP runs as a local subprocess only.
- A handful of Followr API endpoints we have not verified end-to-end yet (analytics edge cases, some Canva flows).

## Where to ask for help

- **Bugs in this MCP:** https://github.com/followr-community/followr-mcp/issues
- **Source code (audit anything):** https://github.com/followr-community/followr-mcp
- **Unofficial Followr API docs:** https://followrapi-docs.pages.dev
- **Followr product support** (account, billing, features): support@followr.ai

## License

MIT. See [LICENSE](https://github.com/followr-community/followr-mcp/blob/main/LICENSE).
