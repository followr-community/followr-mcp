import { FollowrApiError, FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_IDEMPOTENT, READ_ONLY, READ_ONLY_EXTERNAL } from "../lib/annotations.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

export function registerSocialHubTools(
  server: McpServer,
  client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerTool(
    "list_conversations",
    {
      annotations: READ_ONLY,
      title: "List inbox conversations (DMs) for a company",
      description: `List Social Hub conversations across all connected accounts in a company, newest activity first. Each entry includes the external user (DM sender), last message preview, and unread count.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

FILTERS: social_network_id narrows to a single connected account; only_unread=true returns conversations with unread messages (useful for triage).

PRESENTING: refer to external users by name or username, not by id. Surface unread_count prominently when summarizing inbox state.`,
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
      annotations: READ_ONLY,
      title: "Get messages in a conversation",
      description: `Return the messages within a single conversation, newest first.

USE AFTER list_conversations to read full thread content before deciding on a reply or escalation.

ALTERNATIVE: for facebook/instagram conversations, list_platform_messages exposes the raw Meta Graph API shape (different fields, useful for moderation tooling that expects platform-native data).`,
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
      annotations: MUTATION_IDEMPOTENT,
      title: "Mark a conversation as read",
      description: `Mark a Social Hub conversation as read (clears the unread badge for the company).

USE AFTER processing messages via get_conversation_messages. Affects what other teammates see in the company inbox, so don't call as part of "list and skim" flows; only call when the user (or an authorized agent) has actually read and decided on the conversation.`,
      inputSchema: {
        conversation_id: z.number().int().positive(),
      },
    },
    async ({ conversation_id }) => {
      try {
        const updated = await client.markConversationRead(conversation_id);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "list_platform_messages",
    {
      annotations: READ_ONLY_EXTERNAL,
      title: "List messages via the platform-native endpoint (Facebook or Instagram only)",
      description: `Read messages using Followr's platform-specific proxy to the Meta Graph API. Returns the raw Graph API shape (created_time, from, id, message, to).

SUPPORTED NETWORKS: facebook and instagram only. LinkedIn, TikTok, X, Threads, Bluesky return 404 from this proxy. For those networks, use get_conversation_messages.

USE WHEN: building moderation tooling or analytics that expects the Meta Graph API shape. For most agent-driven reply flows, get_conversation_messages is the cleaner choice (normalized across networks).

META 7-DAY WINDOW: the Meta Graph API only exposes messages for conversations whose last_message_at is within the past 7 days. Older conversations cause this proxy to fail. Followr's backend currently returns HTTP 500 (instead of a clean 4xx) when this happens. This tool catches that 500 and surfaces a structured "conversation_out_of_window" error with the suggested remediation (ask the external user to send a new message to reopen the window). Verify the conversation's last_message_at via list_conversations before calling.`,
      inputSchema: {
        platform: z.enum(["facebook", "instagram"]).describe("Only facebook and instagram are supported."),
        conversation_id: z.number().int().positive(),
      },
    },
    async ({ platform, conversation_id }) => {
      try {
        const messages = await client.listPlatformMessages(platform, conversation_id);
        return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
      } catch (err) {
        // Backend returns HTTP 500 when Meta's Graph API rejects the request
        // because the conversation is outside the 7-day window. Detect that
        // case and surface a structured, actionable error instead of the
        // raw 500.
        if (err instanceof FollowrApiError && err.status === 500) {
          return toolError({
            reason: "conversation_out_of_window",
            user_message:
              "Cannot read messages for this conversation. Meta's Graph API only exposes messages from conversations whose last message is within the past 7 days. Followr's backend returns HTTP 500 instead of a clean 4xx for this case, so the error is ambiguous, but the most common cause is the 7-day window. Ask the external user to send a new message to reopen the window, or pick a fresher conversation.",
            suggested_actions: [
              {
                tool: "list_conversations",
                rationale:
                  "Re-list conversations and pick one whose last_message_at is within the past 7 days.",
              },
              {
                rationale:
                  "Ask the external user (the DM sender) to send any new message. That single inbound message reopens the 7-day window and you can then read the full message history.",
              },
            ],
            details: {
              platform,
              conversation_id,
              http_status: err.status,
            },
          });
        }
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "list_contacts",
    {
      annotations: READ_ONLY,
      title: "List external users (contacts) in a company",
      description: `List external users associated with a company. External users are DM senders, followers, or comment authors collected across all connected accounts.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

FILTERS: type narrows to a specific category (e.g. follower, message_sender, comment_author).

PRESENTING: refer to contacts by name or username, never by id.`,
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
      annotations: READ_ONLY,
      title: "List comments on published posts in a company",
      description: `Return comments left on the company's published posts.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.

USE FOR: community-moderation workflows (surface new comments, draft replies, escalate negative sentiment). Optionally narrow to a single post via post_id.

INCLUDE: pass include="externalUser,post" to hydrate author and parent post info in the response.`,
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
