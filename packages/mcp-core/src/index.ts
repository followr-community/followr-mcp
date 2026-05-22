// @followr-mcp/mcp-core: Registers Followr tools against an MCP server instance.
//
// Usage:
//   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
//   import { FollowrClient } from "@followr-mcp/shared";
//   import { registerFollowrTools } from "@followr-mcp/mcp-core";
//
//   const server = new McpServer({ name: "followr", version: "0.1.0" });
//   const client = new FollowrClient({ token: process.env.FOLLOWR_API_TOKEN });
//   registerFollowrTools(server, client);
//
// This package is transport-agnostic. The stdio binary and the Cloudflare Worker
// both consume it.

import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { FOLLOWR_SERVER_INSTRUCTIONS } from "./instructions.js";
export { toolError, toolErrorFromException, ToolErrorException } from "./lib/tool-error.js";
export type { ToolErrorOptions, ToolErrorResult, SuggestedAction } from "./lib/tool-error.js";

import { registerAiResultsTools } from "./tools/ai-results.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerAvatarTools } from "./tools/avatars.js";
import { registerBrandIdentityTools } from "./tools/brand-identity.js";
import { registerCanvaTools } from "./tools/canva.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerContentPlanTools } from "./tools/content-plan.js";
import { registerContextTools } from "./tools/context.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerPostGroupTools } from "./tools/post-groups.js";
import { registerPostTools } from "./tools/posts.js";
import { registerPromptTools } from "./tools/prompts.js";
import { registerResearchTools } from "./tools/research.js";
import { registerAutolistTools } from "./tools/autolist.js";
import { registerRuleGroupTools } from "./tools/rule-groups.js";
import { registerSocialHubTools } from "./tools/social-hub.js";
import { registerSubscriptionTools } from "./tools/subscription.js";
import { registerTagTools } from "./tools/tags.js";
import { registerUserTools } from "./tools/users.js";
import { registerValidateTools } from "./tools/validate.js";
import { registerVoiceTools } from "./tools/voices.js";
import { registerCompanySettingsTools } from "./tools/company-settings.js";
import { registerFollowrResources } from "./resources/index.js";
import { registerFollowrPrompts } from "./prompts/index.js";

export interface RegisterOptions {
  /** Default company id to use when not specified by Claude. Optional. */
  defaultCompanyId?: number;
}

export function registerFollowrTools(
  server: McpServer,
  client: FollowrClient,
  options: RegisterOptions = {},
): void {
  registerContextTools(server, client, options);
  registerCompanyTools(server, client, options);
  registerPostGroupTools(server, client, options);
  registerPostTools(server, client, options);
  registerValidateTools(server, client, options);
  registerTagTools(server, client, options);
  registerAiResultsTools(server, client, options);
  registerAvatarTools(server, client, options);
  registerVoiceTools(server, client, options);
  registerSocialHubTools(server, client, options);
  registerFolderTools(server, client, options);
  registerRuleGroupTools(server, client, options);
  registerAutolistTools(server, client, options);
  registerSubscriptionTools(server, client, options);
  registerUserTools(server, client, options);
  registerCompanySettingsTools(server, client, options);
  registerPromptTools(server, client, options);
  registerAnalyticsTools(server, client, options);
  registerAssetTools(server, client, options);
  registerCanvaTools(server, client, options);
  registerContentPlanTools(server, client, options);
  registerBrandIdentityTools(server, client, options);
  registerResearchTools(server, client, options);
  registerFollowrResources(server, client, options);
  registerFollowrPrompts(server, client, options);
  // v0.1 coverage complete. Future batches:
  //   - Whitelabel + BYOK + Banners (admin-only, low priority)
}

export { type RegisterOptions as FollowrRegisterOptions };
