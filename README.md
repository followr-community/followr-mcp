# Followr MCP

> **UNOFFICIAL.** Community project maintained by Followr Community Maintainers.
> Not endorsed by, affiliated with, or supported by Followr Inc.
> For official support, contact support@followr.ai.

Model Context Protocol (MCP) server for [Followr](https://followr.ai). Connect
Claude Desktop, Claude Code, Cursor, or any MCP-compatible AI client to your
Followr workspace and operate it from natural language: draft and execute
multi-day content plans, schedule posts, generate content with AI, build brand
visual identities, manage avatars and lipsync videos, run automations, triage
the social inbox, and more.

**Status:** v0.7.0. API surface is stabilizing; expect occasional changes
between minor versions until v1.0.

## What it does

Once installed, you can ask Claude things like:

- "Show me the pending drafts in my Acme workspace."
- "Generate 5 short avatar videos about productivity for this week with avatar Sofia."
- "Take this blog post URL and create a thread for X (Twitter), a carousel for Instagram, and a LinkedIn post scheduled for next Monday at 10 AM."
- "Approve draft 1234."
- "List all unread DMs across my Facebook and Instagram accounts."

The MCP exposes:

- **108 tools** spanning multi-day content planning (`draft_content_plan`, `preview_content_plan`, `execute_content_plan`), brand visual identity, deep research, post groups (including `search_posts_by_topic` for semantic queries over the post history), posts (including `create_post` for attaching media per network), tags, folders, assets (`upload_image_from_url`, `delete_asset`), avatars, voices (`create_voice_from_elevenlabs`, `delete_voice`), brand-voice prompts, Canva integration, Social Hub (DMs, comments, contacts), Autopilot rules, AI generation (text/image/audio/lipsync video), analytics, subscription balance, company settings, session orientation (`get_session_context`), and cross-network spec validation (`validate_against_specs`) that warns about caption length, asset count/type/size, video duration, aspect ratio, and per-account constraints (Twitter Premium, TikTok tier) before publishing.
- **6 resources** (catalog endpoints) for companies, calendars, brand voice, avatars, ElevenLabs voices, and individual post groups.
- **5 prompts** (canned multi-tool workflows) for weekly briefs, campaign launches, video series, crisis response, and URL repurposing.

See `packages/mcp-core/src/tools/` for the full tool list with descriptions.

## Installation

The MCP is published on npm as `@followr/mcp` and runs as a local subprocess
of your AI client. Pick the section that matches your client; full step-by-step
with troubleshooting lives in
[`packages/stdio/README.md`](packages/stdio/README.md).

### Quick start: Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS path; see the full README for Windows / Linux):

```json
{
  "mcpServers": {
    "followr": {
      "command": "npx",
      "args": ["-y", "@followr/mcp"],
      "env": {
        "FOLLOWR_API_TOKEN": "PASTE_YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Fully quit and reopen Claude Desktop. The `followr` connector appears once
the initial `npx` download completes (~5 to 10 seconds first time, cached after).

### Quick start: Claude Code (CLI)

```bash
claude mcp add --scope user followr --env 'FOLLOWR_API_TOKEN=PASTE_YOUR_API_KEY_HERE' -- npx -y @followr/mcp
```

The **single quotes** around the env var are mandatory: Followr API keys contain
a `|` (pipe) which the shell would otherwise interpret as a pipe operator,
truncating the API key and producing 401 errors on every call. `--scope user`
makes the MCP available in every project.

Verify with `claude mcp get followr`. Expected `Status: ✓ Connected` and
`Scope: User config`.

### Quick start: Cursor

Edit `~/.cursor/mcp.json` (or the `Cursor Settings → MCP` panel). Use the same
JSON shape as Claude Desktop.

## Generate your Followr API key

1. Sign in at https://app.followr.ai.
2. Click your profile picture in the top-left, then select **API Keys** from the dropdown menu (shortcut: https://app.followr.ai/settings/api-keys).
3. Click **Generate**, name it (e.g. "Claude MCP").
4. Copy the API key. Followr only shows it once.

> ⚠️ **The Followr API is only available on plans that include API access, or
> on plans with the API key add-on.** If your plan doesn't include it, the MCP
> will install but every call will return 401. Verify your plan at
> https://app.followr.ai before continuing.

> ⚠️ **Treat the API key like a password.** Never paste it in a chat (Claude,
> Slack, GitHub issues, anywhere). Paste it only into your terminal or your
> local config file. If an API key leaks, revoke it in the same Followr UI and
> generate a new one.

The MCP reads the `FOLLOWR_API_TOKEN` env var at startup (the env var keeps its
historical name; the value is your Followr API key), uses it for all Followr
API calls, never logs it, never sends it anywhere other than `api.followr.ai`,
and never stores it on disk. Source code is auditable in this repo.

## Repository structure

npm workspaces monorepo:

```
followr-mcp/
  packages/
    shared/      Followr API client (TypeScript), reusable across satellites
    mcp-core/    MCP server core: tools, resources, prompts
    stdio/       npm package entrypoint for local MCP clients (Claude Desktop, Code, Cursor)
    worker/      Cloudflare Worker stub for remote HTTP transport (work in progress)
```

## Followr API documentation

The endpoints exercised by this MCP are documented in the community-maintained
unofficial reference: **https://followrapi-docs.pages.dev**. Followr's official
documentation lives at https://api.followr.ai/docs/.

## Contributing

Issues and pull requests are welcome at
https://github.com/followr-community/followr-mcp.

## License

MIT. See [LICENSE](LICENSE).
