// Followr MCP Cloudflare Worker (Streamable HTTP transport).
//
// PLACEHOLDER for v0.2. v0.1 only ships the stdio binary (@followr/mcp).
// Remote HTTP transport requires:
//   - Streamable HTTP server transport from @modelcontextprotocol/sdk
//   - Bearer auth pass-through (user pastes their FOLLOWR_API_TOKEN at connector setup)
//   - Per-request FollowrClient instantiation with the token
//   - Optional KV-backed rate limit per token
//
// To be implemented after v0.1 ships and gathers feedback.

export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({
        status: "not_implemented",
        message:
          "Followr MCP remote HTTP transport is coming in v0.2. For v0.1, use the stdio binary @followr/mcp via Claude Desktop, Claude Code, or Cursor.",
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  },
};
