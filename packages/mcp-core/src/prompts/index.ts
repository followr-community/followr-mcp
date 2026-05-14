import { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";

// Prompts wrap canned multi-tool workflows. Each one returns a user-role message
// that tells Claude what to do, with structured guidance on which tools to invoke.
// Claude then executes the actual tool calls (we don't pre-execute anything in the
// prompt body itself; the prompt is just instructions plus context).

export function registerFollowrPrompts(
  server: McpServer,
  _client: FollowrClient,
  _options: RegisterOptions,
): void {
  server.registerPrompt(
    "followr.weekly-brief",
    {
      title: "Generate a week of scheduled posts from a brief",
      description:
        "Take a free-form weekly brief and produce a full week of scheduled posts in the workspace. Anchors to the workspace's brand voice, picks suitable networks, drafts copy + images, and schedules across the week.",
      argsSchema: {
        company_id: z.string().describe("Followr company id."),
        brief: z.string().describe("Free-form brief for the week. Topics, hooks, must-mentions, banned terms, target audience notes."),
        networks: z
          .string()
          .optional()
          .describe("Comma-separated network types (instagram, facebook, etc). Defaults to all connected accounts."),
        posts_per_day: z.string().optional().describe("Integer; default 1."),
        starting_iso_date: z
          .string()
          .optional()
          .describe("ISO 8601 date for day 1 of the week. Defaults to tomorrow at 10:00 in the workspace timezone."),
      },
    },
    ({ company_id, brief, networks, posts_per_day, starting_iso_date }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `You are operating inside the Followr MCP. Plan and schedule a full week of social posts for company_id=${company_id} based on this brief:\n\n` +
              `<brief>\n${brief}\n</brief>\n\n` +
              `Constraints:\n` +
              `- Networks: ${networks ?? "use every connected account in the workspace"}\n` +
              `- Posts per day: ${posts_per_day ?? "1"}\n` +
              `- Starting from: ${starting_iso_date ?? "tomorrow at 10:00 in the workspace timezone"}\n\n` +
              `Procedure:\n` +
              `1. Read the brand voice from the followr://company/${company_id}/brand resource.\n` +
              `2. Read the workspace calendar from followr://company/${company_id}/calendar to avoid collisions.\n` +
              `3. Draft N post ideas honoring brand voice and brief.\n` +
              `4. For each idea: optionally generate an image with generate_image, then create_post_group + create_post for the chosen networks, then update_post_group with publish_at.\n` +
              `5. Return a summary: { post_group_id, publish_at, networks, title } for each scheduled post.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "followr.campaign-launch",
    {
      title: "Launch a multi-network campaign end-to-end",
      description:
        "Spin up a full campaign in one shot: hashtag/tag taxonomy, brand-aligned hero asset, teaser + launch + follow-up posts across selected networks, scheduled around the launch date.",
      argsSchema: {
        company_id: z.string().describe("Followr company id."),
        campaign_name: z.string(),
        launch_iso_date: z.string().describe("ISO 8601 launch datetime in UTC."),
        networks: z.string().describe("Comma-separated network types."),
        product_or_offer: z.string().describe("What the campaign is selling or announcing."),
        primary_cta: z.string().describe("The single CTA (e.g. 'Sign up at acme.com/launch')."),
        teaser_days_before: z.string().optional().describe("How many days before launch to start teasers. Default 3."),
        followup_days_after: z.string().optional().describe("How many days after launch to keep follow-up posts. Default 7."),
      },
    },
    ({
      company_id,
      campaign_name,
      launch_iso_date,
      networks,
      product_or_offer,
      primary_cta,
      teaser_days_before,
      followup_days_after,
    }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Launch the "${campaign_name}" campaign for company_id=${company_id}.\n\n` +
              `Inputs:\n` +
              `- Launch date: ${launch_iso_date}\n` +
              `- Networks: ${networks}\n` +
              `- Product / offer: ${product_or_offer}\n` +
              `- Primary CTA: ${primary_cta}\n` +
              `- Teaser window: ${teaser_days_before ?? "3"} days before launch\n` +
              `- Follow-up window: ${followup_days_after ?? "7"} days after launch\n\n` +
              `Procedure:\n` +
              `1. Read brand voice via followr://company/${company_id}/brand.\n` +
              `2. Use find_or_create_tag to ensure a tag named "${campaign_name}" exists; remember its id.\n` +
              `3. Generate one hero visual with generate_image (image-to-image with brand reference if available).\n` +
              `4. Upload the hero via upload_image_from_url (or attach the AI-generated URL).\n` +
              `5. Draft and schedule: (a) a teaser series in the teaser window, (b) a launch announcement on the launch date, (c) follow-up posts and social proof across the follow-up window.\n` +
              `6. Tag every PostGroup with the campaign tag id.\n` +
              `7. Return a manifest: array of { post_group_id, role: 'teaser' | 'launch' | 'followup', publish_at, networks }.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "followr.video-series",
    {
      title: "Generate an avatar video series on a single topic",
      description:
        "Produce N short avatar videos on a topic. One script per episode, one lipsync render per episode, all scheduled across N consecutive days.",
      argsSchema: {
        company_id: z.string(),
        avatar_id: z.string().describe("Avatar to use (from list_avatars or create_avatar_full_flow)."),
        topic: z.string().describe("The topic / theme of the series."),
        episode_count: z.string().describe("Number of episodes (1-30 reasonable)."),
        networks: z.string().describe("Comma-separated network types. Vertical 9:16 will be used for Reels / Shorts."),
        starting_iso_date: z.string().describe("ISO 8601 datetime for episode 1."),
        cadence: z
          .string()
          .optional()
          .describe("daily | every-other-day | weekly. Default daily."),
      },
    },
    ({ company_id, avatar_id, topic, episode_count, networks, starting_iso_date, cadence }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Produce an avatar video series for company_id=${company_id} using avatar_id=${avatar_id}.\n\n` +
              `Inputs:\n` +
              `- Topic: ${topic}\n` +
              `- Episodes: ${episode_count}\n` +
              `- Networks: ${networks}\n` +
              `- Starting: ${starting_iso_date}\n` +
              `- Cadence: ${cadence ?? "daily"}\n\n` +
              `Procedure:\n` +
              `1. Read brand voice via followr://company/${company_id}/brand.\n` +
              `2. With generate_text, brainstorm N distinct episode angles for the topic, each with a 100-150 character on-camera script.\n` +
              `3. For each episode, call generate_avatar_video with avatar_id and the script. WARNING: each render costs ~775 credits. Confirm credit balance via get_credits_balance BEFORE proceeding if uncertain.\n` +
              `4. After each video completes, create_post_group + create_post(network) with the video asset attached, then update_post_group with publish_at.\n` +
              `5. Return a manifest of { episode_n, post_group_id, publish_at, ai_result_id, networks }.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "followr.crisis-response",
    {
      title: "Draft three crisis-response variants for review",
      description:
        "Quickly produce three differently-toned crisis-response post drafts (apology, clarification, deflection) staged as drafts (not auto-publish) so a human can approve one.",
      argsSchema: {
        company_id: z.string(),
        situation: z.string().describe("What happened, key facts, sensitivity notes."),
        networks: z.string().describe("Comma-separated network types."),
        urgency_window_hours: z.string().optional().describe("How many hours until the post should ideally go live. Default 4."),
      },
    },
    ({ company_id, situation, networks, urgency_window_hours }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Handle a crisis-response need for company_id=${company_id}.\n\n` +
              `Situation:\n${situation}\n\n` +
              `Constraints:\n` +
              `- Networks: ${networks}\n` +
              `- Urgency window: ${urgency_window_hours ?? "4"} hours\n\n` +
              `Procedure:\n` +
              `1. Read brand voice via followr://company/${company_id}/brand. Honor it but lean conservative.\n` +
              `2. With generate_text (or your own composition), draft THREE distinct response variants:\n` +
              `   - Variant A: full apology + concrete remediation.\n` +
              `   - Variant B: clarification (assumes the situation is a misunderstanding).\n` +
              `   - Variant C: deflection / "no comment beyond this short statement".\n` +
              `3. For EACH variant: create_post_group with draft=true (do NOT publish), title prefixed "CRISIS DRAFT - ". Create one post per network with the variant text.\n` +
              `4. Tag every PostGroup with a "crisis-${Date.now()}" tag via find_or_create_tag.\n` +
              `5. Return three post_group_ids with their variant labels. Do NOT call publish_post_group_now. A human will pick one and publish.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "followr.repurpose-from-url",
    {
      title: "Repurpose a single URL into multi-network posts",
      description:
        "Given a URL (blog post, news article, video), produce network-tailored versions across the requested networks, with the right format (carousel, single image, video, blog post) per network.",
      argsSchema: {
        company_id: z.string(),
        source_url: z.string().describe("The URL to repurpose (article, blog post, video)."),
        networks: z.string().describe("Comma-separated networks."),
        publish_at: z.string().optional().describe("ISO 8601 datetime. If omitted, leave as draft."),
        include_visual: z
          .string()
          .optional()
          .describe("If 'true', generate a fresh image per network format. Default 'true'."),
      },
    },
    ({ company_id, source_url, networks, publish_at, include_visual }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Repurpose ${source_url} into multi-network posts for company_id=${company_id}.\n\n` +
              `Constraints:\n` +
              `- Networks: ${networks}\n` +
              `- Publish at: ${publish_at ?? "leave as draft"}\n` +
              `- Generate visuals: ${include_visual ?? "true"}\n\n` +
              `Procedure:\n` +
              `1. Read brand voice via followr://company/${company_id}/brand.\n` +
              `2. Fetch the URL (use your native web tools) and extract: title, key takeaways (3-7 bullets), tone, suggested hashtags.\n` +
              `3. For EACH network, tailor format and length:\n` +
              `   - twitter/X: 1-2 punchy posts, 280 chars max, link to source.\n` +
              `   - linkedin: 1 long-form post with 3-5 takeaways and a soft CTA.\n` +
              `   - instagram: caption + ${include_visual === "false" ? "no image" : "1-3 generated images forming a carousel"}.\n` +
              `   - facebook: similar to linkedin, slightly more casual.\n` +
              `   - tiktok / youtube: if requested, generate a short script and (optionally) an avatar video via generate_avatar_video.\n` +
              `   - medium (blog post): full repost in workspace voice with credit to source.\n` +
              `4. If include_visual is true, call generate_image once per format that needs visuals (use image_url=primary image of the source as reference for consistency).\n` +
              `5. Create one PostGroup tied together by a shared tag (find_or_create_tag). One post per network. Schedule with publish_at if provided.\n` +
              `6. Return a manifest: { source_url, post_group_id, posts: [{ network, draft_preview, asset_count }] }.`,
          },
        },
      ],
    }),
  );
}
