import { FollowrApiError, FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { DESTRUCTIVE, MUTATION_IDEMPOTENT, READ_ONLY, READ_ONLY_EXTERNAL } from "../lib/annotations.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

// Meta enforces a ~24-hour messaging window for business accounts on both
// Instagram and Facebook. Past that window, sends are rejected by Meta's
// Graph API; Followr propagates the rejection as HTTP 500 without a clean
// semantic error. We use this constant to pre-check `last_message_at` before
// the round-trip when the agent provides the hint, and to phrase the
// structured error consistently.
const META_24H_WINDOW_MS = 24 * 60 * 60 * 1000;

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
      title: "Get messages in a conversation (text only, no attachments)",
      description: `Return text messages within a single conversation, newest first. Reads from Followr's local cache; works for ANY conversation regardless of age.

ATTACHMENT GAP: this endpoint does NOT expose attachments (image/video). Messages that arrived as attachment-only show up with message: "". For Instagram and Facebook conversations that may contain media, prefer list_platform_messages — it returns the raw Meta Graph shape including attachments.data[*].image_data / video_data.

USE THIS when: text-only summary is enough; or when working with a network without a platform-specific endpoint (LinkedIn, TikTok, X, Threads, Bluesky etc).

USE list_platform_messages when: the conversation is Instagram or Facebook AND attachments could be present (most inbound IG/FB DMs).`,
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
    "reply_to_conversation",
    {
      annotations: DESTRUCTIVE,
      title: "Send a text reply to a Social Hub conversation (DM to IG/FB)",
      description: `Send a text reply to a Social Hub conversation. Followr's backend proxies to Meta's Graph API and the DM is delivered to the external user on Instagram or Facebook. Verified empirically on both networks (sesión 12, 2026-05-20).

IRREVERSIBLE PUBLIC ACTION: once this returns 201, the message is on the user's IG/FB inbox. Followr cannot un-send. Treat with the same care as publish_post_group_now.

APPROVAL GATE (REQUIRED): the caller MUST pass confirm: true. Any other value (including omission, false, "true" as a string) causes the tool to refuse. This is the explicit user-confirmation invariant: before calling, the agent must have shown the user the EXACT message text, named the recipient by username or external user name (never id), and received explicit approval in chat ("dale, mandalo" / "send it" / "yes"). Generic intents like "answer the unread DMs" do NOT authorize this tool; the agent must confirm each reply individually unless the user has explicitly granted batch authorization in the same conversation.

24-HOUR WINDOW: Meta enforces a ~24h messaging window from the external user's last inbound message. Past 24h, Meta rejects the send and Followr's backend returns HTTP 500 ("Server Error"). The tool catches that 500 and surfaces a structured "conversation_out_of_window" error. To avoid wasting the round-trip, pass last_message_at (taken from list_conversations) and the tool will pre-check and refuse without hitting the API.

OUT OF WINDOW REMEDIATION: a conversation outside the 24h window can only be re-opened by the external user sending a new message. There is no tag, no extension, no workaround that the agent can apply. Surface this to the user and move on to other conversations.

TEXT ONLY: this endpoint does NOT support attachments. Attempting to send an image/video/audio/file is impossible today (Followr backend ignores any attachment field). Gap Z11 in /docs/followr-api/_gaps.md tracks the feature request to extend the endpoint.`,
      inputSchema: {
        conversation_id: z.number().int().positive(),
        message: z.string().min(1).max(1000).describe("The text to send. Meta limits IG text to 1000 chars; this tool enforces the same cap client-side."),
        confirm: z
          .literal(true)
          .describe(
            "Must be the literal boolean true. The MCP refuses any other value. This is the chat-side confirmation gate: the agent must have shown the message and recipient to the user out loud, received explicit approval, and only then passes confirm: true.",
          ),
        last_message_at: z
          .string()
          .optional()
          .describe(
            "Optional ISO 8601 timestamp of the conversation's last message (typically taken from list_conversations response). If provided, the tool pre-checks the 24h window and refuses without hitting the API when out of window. Saves a round-trip on guaranteed-failing sends.",
          ),
      },
    },
    async ({ conversation_id, message, confirm, last_message_at }) => {
      // Approval gate. The literal-true Zod schema already enforces this at
      // input validation time, but we re-check defensively in case a future
      // schema change relaxes the type and to make the failure mode loud.
      if (confirm !== true) {
        return toolError({
          reason: "user_must_confirm_send",
          user_message:
            "Refusing to send. reply_to_conversation requires the caller to pass confirm: true after asking the user out loud and getting an explicit yes. Show the message text and recipient name to the user, ask for confirmation, and only then call this tool with confirm: true.",
          suggested_actions: [
            {
              rationale:
                "Ask the user explicitly: state the recipient's name or username, state the EXACT message to be sent verbatim, and wait for an explicit 'yes' / 'send it' / 'dale, mandalo' before retrying with confirm: true.",
            },
          ],
          details: { conversation_id },
        });
      }

      // Pre-flight: if the agent provided last_message_at, check the 24h
      // window before hitting the API. Saves a round-trip on guaranteed-
      // failing sends. Skipped when last_message_at is missing or invalid.
      if (last_message_at) {
        const lastMs = Date.parse(last_message_at);
        if (!Number.isNaN(lastMs)) {
          const ageMs = Date.now() - lastMs;
          if (ageMs > META_24H_WINDOW_MS) {
            const hoursSince = Math.round(ageMs / (60 * 60 * 1000));
            return toolError({
              reason: "conversation_out_of_window",
              user_message: `Cannot send to this conversation. Meta enforces a 24-hour messaging window for IG and FB business accounts; the last message in this conversation is from ${hoursSince}h ago. The external user must send a new message to reopen the window. There is no extension the integrator can apply.`,
              suggested_actions: [
                {
                  rationale:
                    "Inform the user that this conversation is past Meta's 24h window. Skip it and continue with conversations whose last_message_at is within the past 24 hours.",
                },
                {
                  tool: "list_conversations",
                  rationale:
                    "Re-list conversations and filter to those whose last_message_at is within the past 24 hours; those are the ones that can still accept a reply.",
                },
              ],
              details: {
                conversation_id,
                last_message_at,
                hours_since_last_message: hoursSince,
                window_hours: 24,
              },
            });
          }
        }
      }

      // Send. Catch 500 (Meta out-of-window leak) and 422 (validation) and
      // map to structured errors. Other errors bubble through the generic
      // exception handler.
      try {
        const sent = await client.sendMessage(conversation_id, message);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  message_id: sent.id,
                  external_id: sent.external_id,
                  conversation_id: sent.conversation_id,
                  sender: sent.sender,
                  sent_at: sent.created_at,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof FollowrApiError) {
          // 500: Meta rejected, most commonly because the conversation is
          // outside the 24h window. Followr's backend leaks Meta's failure
          // as a generic 500 without semantic detail. Map defensively.
          if (err.status === 500) {
            return toolError({
              reason: "conversation_out_of_window",
              user_message:
                "Cannot send to this conversation. Followr's backend returned HTTP 500, which most commonly indicates Meta rejected the send because the conversation is outside the 24-hour messaging window. The external user must send a new message to reopen the window. There is no extension the integrator can apply.",
              suggested_actions: [
                {
                  rationale:
                    "Inform the user that this conversation appears to be past Meta's 24h window and could not be replied to. Skip it and continue with fresher conversations.",
                },
                {
                  tool: "list_conversations",
                  rationale:
                    "Re-list conversations and filter to those whose last_message_at is within the past 24 hours.",
                },
              ],
              details: {
                conversation_id,
                http_status: err.status,
              },
            });
          }
          // 422: validation error. Map to a focused structured error so the
          // agent knows which field is wrong.
          if (err.status === 422) {
            const errors = err.validationErrors ?? {};
            const fields = Object.keys(errors);
            if (fields.includes("conversation_id")) {
              return toolError({
                reason: "conversation_inaccessible",
                user_message:
                  "The selected conversation_id is invalid for the current API token (either it doesn't exist or this token doesn't have access).",
                suggested_actions: [
                  {
                    tool: "list_conversations",
                    rationale: "Re-list conversations under the user's company to get a current set of accessible conversation ids.",
                  },
                ],
                details: { conversation_id, errors },
              });
            }
            if (fields.includes("message")) {
              return toolError({
                reason: "empty_or_invalid_message",
                user_message:
                  "The message field is invalid (most commonly empty after trimming, or rejected by Followr's validator).",
                suggested_actions: [
                  {
                    rationale: "Re-draft a non-empty message of 1 to 1000 characters and call this tool again with confirm: true.",
                  },
                ],
                details: { conversation_id, errors },
              });
            }
            return toolError({
              reason: "validation_error",
              user_message: err.message ?? "Followr rejected the send with a validation error.",
              details: { conversation_id, errors },
            });
          }
        }
        return toolErrorFromException(err);
      }
    },
  );

  server.registerTool(
    "list_platform_messages",
    {
      annotations: READ_ONLY_EXTERNAL,
      title: "List messages via the platform-native endpoint (Facebook or Instagram only)",
      description: `Read messages using Followr's platform-specific proxy to the Meta Graph API. Returns the raw Graph API shape (created_time, from, id, message, to, attachments).

SUPPORTED NETWORKS: facebook and instagram only. LinkedIn, TikTok, X, Threads, Bluesky return 404 from this proxy. For those networks, use get_conversation_messages.

ATTACHMENTS: this endpoint exposes attachments (image_data, video_data) which the cache-based get_conversation_messages does NOT. Prefer this tool for IG/FB inboxes where DMs may include media.

READ WORKS REGARDLESS OF AGE: verified empirically, the read side serves messages from Followr's local cache and does not enforce Meta's 7-day window. Conversations from many months ago return successfully. The tool still includes defensive handling for HTTP 500: if Followr ever returns 500 (e.g. cache miss falling through to Graph API), the tool surfaces a structured "conversation_out_of_window" error so the agent can react.

ATTACHMENT URL EXPIRY: URLs in attachments.data[*].image_data.url and video_data.url point to Meta's CDN (lookaside.fbsbx.com) and are signed with short-lived signatures. Do NOT cache or persist these URLs long-term; fetch the media immediately if archival is needed.`,
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

  server.registerTool(
    "analyze_inbox_topics",
    {
      annotations: READ_ONLY,
      title: "Aggregate inbound DMs into a corpus for topic analysis",
      description: `Aggregate inbound DMs from the Social Hub into a structured corpus the agent can analyze for recurring topics, trends, sentiment, and product/content signals.

WHAT IT DOES: lists Social Hub conversations for a company within a date range; reads recent messages for each; filters to inbound-only (sender = 'external-user') text messages within the range; returns a structured corpus organized per conversation. The agent then clusters topics, summarizes themes, and surfaces insights from the corpus directly (no embedding/clustering inside the tool; Claude with a long context window handles that natively).

USE CASES: "what are people asking us this month", "most common complaints in the past week", "spike of new topics vs last period", "topics by network", "lead-quality DMs vs spam". Drives content strategy, product roadmap, support staffing.

WHY NO EMBEDDING/CLUSTERING INSIDE THE TOOL: keeping it text-only and structured leaves the analysis where it belongs (the agent). The corpus is bounded by the date range and max_conversations cap, so the agent's context window absorbs it cleanly. Future versions may add server-side clustering for very large inboxes (>10k messages); not needed for typical company inboxes.

PRESENTING: when the agent reports findings, group by topic with sample DMs (paraphrased, not verbatim if user privacy matters), counts, and trends. Use network-aware language ("on Instagram you got 12 DMs about pricing").

DATE RANGE DEFAULTS: since defaults to 30 days ago; until defaults to now. All timestamps in ISO 8601 UTC.

ATTACHMENT-ONLY DMS ARE EXCLUDED: this tool reads from the cache (text-only, no attachments). Messages that arrived as pure image/video show up with empty text and are filtered out of the corpus. For inbox triage that includes media, use list_platform_messages for the specific conversations instead.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        since: z
          .string()
          .optional()
          .describe("ISO 8601 lower bound (inclusive). Defaults to 30 days ago."),
        until: z
          .string()
          .optional()
          .describe("ISO 8601 upper bound (inclusive). Defaults to now."),
        social_network_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional: limit to a single connected account."),
        max_conversations: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max conversations to scan. Default 30, hard cap 100. Larger inboxes should be split into multiple calls by date range."),
        max_messages_per_conversation: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Max recent messages to read per conversation. Default 30."),
      },
    },
    async ({ company_id, since, until, social_network_id, max_conversations, max_messages_per_conversation }) => {
      const now = Date.now();
      const defaultSinceMs = now - 30 * 24 * 60 * 60 * 1000;
      const sinceMs = since ? Date.parse(since) : defaultSinceMs;
      const untilMs = until ? Date.parse(until) : now;
      if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
        return toolError({
          reason: "invalid_date_range",
          user_message: "Both since and until (when provided) must be ISO 8601 datetimes (e.g. 2026-05-01T00:00:00Z).",
          details: { since, until },
        });
      }
      if (untilMs < sinceMs) {
        return toolError({
          reason: "invalid_date_range",
          user_message: "until must be on or after since.",
          details: { since, until },
        });
      }
      const sinceIso = new Date(sinceMs).toISOString();
      const untilIso = new Date(untilMs).toISOString();
      const convCap = max_conversations ?? 30;
      const msgCap = max_messages_per_conversation ?? 30;

      // Pull conversations with a generous cap; we filter client-side by
      // last_message_at in range. Larger workspaces with hundreds of active
      // conversations should split by date range across multiple calls.
      const conversations = await client.listConversations(company_id, {
        ...(social_network_id !== undefined ? { socialNetworkId: social_network_id } : {}),
        pageSize: 100,
      });

      // A conversation is in-range if its last_message_at falls inside
      // [sinceMs, untilMs]. This is a rough cut: conversations whose last
      // activity is older than sinceMs may still have had messages inside
      // the range, but for typical "last 30 days" queries the rough cut is
      // fine. Sorted newest-first; we cap at convCap.
      const inRange = conversations
        .filter((c) => {
          const lastAt = c.lastMessage?.created_at ?? c.updated_at;
          const lastMs = Date.parse(lastAt);
          return !Number.isNaN(lastMs) && lastMs >= sinceMs;
        })
        .slice(0, convCap);

      // Read messages for each in-range conversation. We parallelize with
      // Promise.all to keep latency down; per-conversation calls are
      // independent. If any conversation read fails, we skip it and
      // continue (the analysis is robust to partial data).
      const results = await Promise.all(
        inRange.map(async (c) => {
          try {
            const messages = await client.listMessages(c.id, { pageSize: msgCap });
            const inbound = messages.filter((m) => {
              if (m.sender !== "external-user") return false;
              const ts = Date.parse(m.created_at);
              if (Number.isNaN(ts)) return false;
              if (ts < sinceMs || ts > untilMs) return false;
              const text = (m.message ?? "").trim();
              return text.length > 0;
            });
            return { conversation: c, messages: inbound };
          } catch {
            return { conversation: c, messages: [] };
          }
        }),
      );

      const corpus = results
        .filter((r) => r.messages.length > 0)
        .map((r) => ({
          conversation_id: r.conversation.id,
          network: r.conversation.externalUser?.type ?? null,
          external_user: r.conversation.externalUser
            ? {
                name: r.conversation.externalUser.name,
                username: r.conversation.externalUser.username,
              }
            : null,
          last_message_at: r.conversation.lastMessage?.created_at ?? r.conversation.updated_at,
          inbound_message_count: r.messages.length,
          inbound_messages: r.messages.map((m) => ({
            text: m.message,
            created_at: m.created_at,
          })),
        }));

      const totals = {
        conversations_scanned: conversations.length,
        conversations_in_range: inRange.length,
        conversations_with_inbound_in_range: corpus.length,
        inbound_messages: corpus.reduce((acc, c) => acc + c.inbound_message_count, 0),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                period: { since: sinceIso, until: untilIso },
                totals,
                corpus,
                agent_instructions:
                  "This is raw material for the agent to analyze. Cluster the inbound_messages mentally by recurring themes (pricing, support, complaint, lead, spam, general). Report top topics with counts, sample DMs (paraphrased if privacy matters), and any signal worth surfacing to the user (trend changes, sentiment spikes, leads to act on). Refer to people by name or username, never by id.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
