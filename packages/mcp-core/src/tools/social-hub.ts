import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

export function registerSocialHubTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_conversations",
    {
      title: "List inbox conversations (DMs) for a workspace",
      description:
        "List Social Hub conversations across all connected accounts in a workspace, newest activity first. Each entry includes the external user (DM sender), last message preview, and unread count. Use this to triage the inbox or auto-reply.",
      inputSchema: {
        company_id: z.number().int().positive(),
        social_network_id: z.number().int().positive().optional().describe("Optional: limit to a specific connected account."),
        only_unread: z.boolean().optional().describe("If true, only return conversations with unread messages."),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, social_network_id, only_unread, page_size }) => {
      const conversations = await client.listConversations(company_id, {
        ...(social_network_id !== undefined ? { socialNetworkId: social_network_id } : {}),
        ...(only_unread ? { hasUnreadMessages: true } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              conversations.map((c) => ({
                id: c.id,
                social_network_id: c.social_network_id,
                external_user: c.externalUser
                  ? {
                      id: c.externalUser.id,
                      name: c.externalUser.name,
                      username: c.externalUser.username,
                      type: c.externalUser.type,
                    }
                  : null,
                last_message_preview: c.lastMessage?.message?.slice(0, 200) ?? null,
                last_message_at: c.lastMessage?.created_at ?? null,
                unread_count: c.unreadMessages_count ?? 0,
                updated_at: c.updated_at,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_conversation_messages",
    {
      title: "Get messages in a conversation",
      description:
        "Return the messages within a single conversation, newest first. Use this after list_conversations to read full thread content before deciding on a reply.",
      inputSchema: {
        conversation_id: z.number().int().positive(),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ conversation_id, page_size }) => {
      const messages = await client.listMessages(conversation_id, {
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(messages, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "mark_conversation_read",
    {
      title: "Mark a conversation as read",
      description:
        "Mark a Social Hub conversation as read (clears the unread badge). Use this after processing messages from get_conversation_messages.",
      inputSchema: {
        conversation_id: z.number().int().positive(),
      },
    },
    async ({ conversation_id }) => {
      const updated = await client.markConversationRead(conversation_id);
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    },
  );

  server.registerTool(
    "list_platform_messages",
    {
      title: "List messages via the platform-native endpoint (Facebook or Instagram only)",
      description:
        "Read messages using Followr's platform-specific proxy to the Meta Graph API. Only supported for Facebook and Instagram conversations (other networks like LinkedIn, TikTok, X, Threads, Bluesky return 404 from this proxy and should use get_conversation_messages instead). Returns the raw Graph API shape with created_time, from, id, message, to fields.",
      inputSchema: {
        platform: z.enum(["facebook", "instagram"]).describe("Only facebook and instagram are supported."),
        conversation_id: z.number().int().positive(),
      },
    },
    async ({ platform, conversation_id }) => {
      const messages = await client.listPlatformMessages(platform, conversation_id);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    },
  );

  server.registerTool(
    "list_contacts",
    {
      title: "List external users (contacts) in a workspace",
      description:
        "List external users associated with a workspace. External users are DM senders, followers, or comment authors collected across all connected accounts. Use this to see who has interacted with the brand recently. Internally calls /api/externalUsers (which is the same resource the Followr UI's Contacts page reads from).",
      inputSchema: {
        company_id: z.number().int().positive(),
        type: z.string().optional().describe("Optional filter by external user type (e.g. follower, message_sender, comment_author)."),
        page_size: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ company_id, type, page_size }) => {
      const contacts = await client.listExternalUsers(company_id, {
        ...(type ? { type } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              contacts.map((c) => ({
                id: c.id,
                name: c.name,
                username: c.username,
                type: c.type,
                external_id: c.external_id,
                last_interaction_at: c.last_interaction_at,
                description: c.description,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments on published posts in a workspace",
      description:
        "Return comments left on the workspace's published posts. Use this for community-moderation workflows: surface new comments, draft replies, escalate negative sentiment. Optionally narrow to a single post via post_id.",
      inputSchema: {
        company_id: z.number().int().positive(),
        post_id: z.number().int().positive().optional().describe("Optional: limit to a single post."),
        page_size: z.number().int().positive().max(100).optional(),
        include: z.string().optional().describe("Optional include chain (e.g. 'externalUser,post')."),
      },
    },
    async ({ company_id, post_id, page_size, include }) => {
      const comments = await client.listComments(company_id, {
        ...(post_id !== undefined ? { postId: post_id } : {}),
        ...(page_size ? { pageSize: page_size } : {}),
        ...(include ? { include } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
    },
  );
}
