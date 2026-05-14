import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RegisterOptions } from "../index.js";

export function registerSubscriptionTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "get_credits_balance",
    {
      title: "Get the current credit and quota balance for the API token",
      description:
        "Return the subscription balance for the current API token: AI credits remaining, words allowed/spent, images allowed/spent, bytes (storage) allowed/spent, plan features (whitelabel, plus_chat, getlead), and renewal timestamp. The balance is scoped to the token's owner (per-user), not per-workspace. Use this before kicking off expensive operations like generate_avatar_video (775+ credits) or create_avatar_full_flow (25+ credits).",
      inputSchema: {},
    },
    async () => {
      const balance = await client.getSubscriptionBalance();
      return { content: [{ type: "text", text: JSON.stringify(balance, null, 2) }] };
    },
  );
}
