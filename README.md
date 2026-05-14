# Followr MCP

> **UNOFFICIAL.** Community project maintained by Followr Community Maintainers.
> Not endorsed by, affiliated with, or supported by Followr Inc.
> For official support, contact support@followr.ai.

Model Context Protocol (MCP) server for [Followr](https://followr.ai). Connect
Claude Desktop, Claude Code, Cursor, or any MCP-compatible AI client to your
Followr workspace and operate it from natural language: schedule posts, generate
content with AI, manage avatars and lipsync videos, run automations, triage the
social inbox, and more.

**Status:** v0.1 alpha. API surface is stabilizing; expect occasional changes
between minor versions until v1.0.

## What it does

Once installed, you can ask Claude things like:

- "Show me the pending drafts in my Acme workspace."
- "Generate 5 short avatar videos about productivity for this week with avatar Sofia."
- "Take this blog post URL and create a thread for X (Twitter), a carousel for Instagram, and a LinkedIn post scheduled for next Monday at 10 AM."
- "Approve draft 1234."
- "List all unread DMs across my Facebook and Instagram accounts."

The MCP exposes:

- **61 tools** spanning post groups, posts, tags, folders, assets, avatars, voices, Canva integration, Social Hub (DMs, comments, contacts), Autopilot rules, AI generation (text/image/audio/lipsync video), analytics, subscription balance, and workspace settings.
- **6 resources** (catalog endpoints) for companies, calendars, brand voice, avatars, ElevenLabs voices, and individual post groups.
- **5 prompts** (canned multi-tool workflows) for weekly briefs, campaign launches, video series, crisis response, and URL repurposing.

See `packages/mcp-core/src/tools/` for the full tool list with descriptions.

## Installation

Coming soon. The package will be published to npm as `@followr/mcp` and
installable in Claude Desktop, Claude Code, Cursor, and any other
MCP-compatible client. See `packages/stdio/README.md` for the planned
configuration once the npm release lands.

## Authentication

The MCP requires a Followr API token, provided as the `FOLLOWR_API_TOKEN`
environment variable. Generate one in the Followr UI under
**Company Settings → API Keys → Generate**.

The token is read by the MCP at startup and used for all calls. The MCP never
logs it, never sends it anywhere other than the Followr API, and never stores
it on disk. Source code is auditable in this repo.

## Repository structure

npm workspaces monorepo:

```
followr-mcp/
  packages/
    shared/      Followr API client (TypeScript), reusable across satellites
    mcp-core/    MCP server core: tools, resources, prompts
    stdio/       npm package entrypoint for local MCP clients (Claude Desktop, Code, Cursor)
    worker/      Cloudflare Worker stub for remote HTTP transport (v0.2, work in progress)
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
