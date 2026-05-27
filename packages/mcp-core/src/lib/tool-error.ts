// Structured tool errors.
//
// MCP tools that throw a generic Error end up surfaced to the consuming agent
// as an opaque string. The agent has to parse it as human text to decide what
// to do, which is fragile and language-dependent.
//
// Instead, tools that fail should RETURN a structured error result that:
//   - sets isError: true so the MCP client renders it as a failure;
//   - includes a human-readable user_message in `content` (what the agent
//     surfaces to the user);
//   - includes a machine-readable `structuredContent` block with a stable
//     `reason` category, suggested_actions, and a `details` object so the
//     agent can reason programmatically (retry vs ask user vs escalate).
//
// Use `toolError({...})` for local validation failures the tool knows how to
// describe. Use `toolErrorFromException(err)` to convert any thrown error
// (especially FollowrApiError from the HTTP client) into the same shape,
// applying HTTP-status-aware categorization and suggested actions.

import { FollowrApiError } from "@followr-mcp/shared";

export interface SuggestedAction {
  /** Optional tool name the agent could invoke to resolve the issue. */
  tool?: string;
  /** Why this action would help. Surfaced to the agent. */
  rationale: string;
}

export interface ToolErrorOptions {
  /** Stable machine-readable category. Snake_case. */
  reason: string;
  /** Human-readable message safe to show the end user. */
  user_message: string;
  /** Concrete next steps the agent can take. Order = priority. */
  suggested_actions?: SuggestedAction[];
  /** False if the agent can proceed despite this. Default true. */
  blocking?: boolean;
  /** Arbitrary structured context (ids, http status, validation errors, etc.). */
  details?: Record<string, unknown>;
}

// Note on index signatures below: the MCP SDK's CallToolResult type uses
// `[x: string]: unknown` to support arbitrary extension fields. Without
// matching that on our concrete shape, TypeScript refuses to assign our
// ToolErrorResult to the SDK's expected handler return type.

export interface ToolErrorResult {
  [k: string]: unknown;
  content: Array<{ type: "text"; text: string; [k: string]: unknown }>;
  isError: true;
  structuredContent: {
    [k: string]: unknown;
    ok: false;
    reason: string;
    user_message: string;
    suggested_actions: SuggestedAction[];
    blocking: boolean;
    details?: Record<string, unknown>;
  };
}

/**
 * Throwable wrapper around a structured tool error.
 *
 * Used by helper functions (e.g. uploadFromUrl, pollExportJob) that need to
 * fail with a specific, structured error but can't return ToolErrorResult
 * directly because their signature returns domain data. The handler that
 * called the helper catches via toolErrorFromException, which recognizes
 * ToolErrorException and returns the embedded ToolErrorResult unchanged.
 *
 * This preserves the helper's normal return type while letting helpers emit
 * the same rich error shape as in-handler validation.
 */
export class ToolErrorException extends Error {
  override readonly name = "ToolErrorException";
  constructor(public readonly result: ToolErrorResult) {
    super(result.structuredContent.user_message);
  }
}

export function toolError(opts: ToolErrorOptions): ToolErrorResult {
  const structuredContent: ToolErrorResult["structuredContent"] = {
    ok: false,
    reason: opts.reason,
    user_message: opts.user_message,
    suggested_actions: opts.suggested_actions ?? [],
    blocking: opts.blocking ?? true,
  };
  if (opts.details) {
    structuredContent.details = opts.details;
  }
  return {
    content: [{ type: "text", text: opts.user_message }],
    isError: true,
    structuredContent,
  };
}

/**
 * Convert any thrown exception into a structured ToolErrorResult.
 * - FollowrApiError: categorize by HTTP status with relevant suggested actions.
 * - Other Error: preserve message, mark as unhandled_exception.
 * - Anything else: opaque fallback.
 */
export function toolErrorFromException(err: unknown): ToolErrorResult {
  if (err instanceof ToolErrorException) {
    return err.result;
  }
  if (err instanceof FollowrApiError) {
    const { reason, suggested_actions, user_message_override } = categorizeFollowrError(
      err.status,
      err.body,
      err.validationErrors,
    );
    const details: Record<string, unknown> = {
      http_status: err.status,
      url: err.url,
    };
    if (err.validationErrors) {
      details["validation_errors"] = err.validationErrors;
    }
    // Surface backend's `entity` field for HTTP 402 plan-feature errors so
    // the agent can suggest the right alternative model.
    if (err.body && typeof err.body === "object" && err.body !== null) {
      const b = err.body as Record<string, unknown>;
      if (typeof b["entity"] === "string") {
        details["entity"] = b["entity"];
      }
    }
    return toolError({
      reason,
      user_message: user_message_override ?? err.message,
      suggested_actions,
      blocking: true,
      details,
    });
  }
  if (err instanceof Error) {
    return toolError({
      reason: "unhandled_exception",
      user_message: err.message,
      blocking: true,
      details: { error_name: err.name },
    });
  }
  return toolError({
    reason: "unknown_error",
    user_message: String(err),
    blocking: true,
  });
}

function categorizeFollowrError(
  status: number,
  body?: unknown,
  validationErrors?: Record<string, string[]>,
): { reason: string; suggested_actions: SuggestedAction[]; user_message_override?: string } {
  if (status === 401) {
    return {
      reason: "unauthorized",
      suggested_actions: [
        {
          rationale:
            "Verify FOLLOWR_API_TOKEN is set correctly in the MCP client config (its value should be your Followr API key). Also confirm your Followr plan includes API access. Generate a new key at app.followr.ai (profile picture > API Keys, or app.followr.ai/settings/api-keys) if needed.",
        },
      ],
    };
  }
  if (status === 403) {
    return {
      reason: "forbidden",
      suggested_actions: [
        {
          rationale:
            "The API key does not have permission for this resource. Verify the user has access to the target company.",
        },
      ],
    };
  }
  if (status === 404) {
    return {
      reason: "not_found",
      suggested_actions: [
        {
          rationale:
            "The referenced resource does not exist or was deleted. Re-list to confirm the id is valid before retrying.",
        },
      ],
    };
  }
  if (status === 402) {
    // Followr returns 402 with a body shape `{ entity: "premium_images" | ..., message: "..." }`
    // when the action requires a plan feature the user does not have. Verified
    // empirically 2026-05-19 (POST /aiResults/image with gpt_image_2 on a plan
    // where premium_images_allowed === 0).
    //
    // CRITICAL: the agent must NOT paraphrase or guess what the entity name
    // maps to. PipeLime 2026-05-26: a 402 fired during generate_avatar_video
    // and the agent told the user "tu plan no incluye subtítulos burned-in"
    // when in reality the user's plan DID include subtitles. The actual
    // failure was on a different step of the avatar flow (the entity name
    // surfaced something else). The fix on this side is two-fold:
    //   1) Emit the entity verbatim, never invent a friendly name.
    //   2) Tell the agent to QUOTE the entity literally and verify with
    //      get_ai_budget before claiming "your plan does not include X".
    const entity =
      body && typeof body === "object" && body !== null && typeof (body as Record<string, unknown>)["entity"] === "string"
        ? ((body as Record<string, unknown>)["entity"] as string)
        : undefined;
    const backendMessage =
      body && typeof body === "object" && body !== null && typeof (body as Record<string, unknown>)["message"] === "string"
        ? ((body as Record<string, unknown>)["message"] as string)
        : undefined;
    const messageClause = backendMessage ? ` Backend message: "${backendMessage}".` : "";
    return {
      reason: "plan_does_not_include_feature",
      user_message_override: entity
        ? `The Followr backend rejected this call with HTTP 402 and entity "${entity}". This typically means the current plan does not include a feature this call requires, but the exact feature is whatever "${entity}" maps to on the Followr side, NOT necessarily the feature the agent was trying to use last. Do NOT paraphrase the entity name into a different feature ("subtitles", "Creatomate", "premium video", etc.) unless you can confirm the mapping with get_ai_budget; quote "${entity}" verbatim to the user instead.${messageClause}`
        : `The Followr backend rejected this call with HTTP 402 but did NOT specify which feature is missing (no "entity" field in the response). Do NOT tell the user a specific feature is missing; ask them to verify their plan on the Followr web (app.followr.ai > Subscription) or contact support. The MCP cannot resolve which feature without the entity name.${messageClause}`,
      suggested_actions: [
        {
          tool: "get_ai_budget",
          rationale: entity
            ? `Read get_ai_budget and look for a quota or boolean flag matching "${entity}". If you find one with value 0 / false, the plan genuinely lacks that feature. If you do NOT find any matching field, the entity name may reference a backend feature not exposed in the budget; in that case tell the user the literal entity name and recommend contacting Followr support rather than guessing.`
            : "Read get_ai_budget to surface the plan name + active addons + per-feature flags. Share that with the user so they can decide whether to upgrade or contact support.",
        },
        {
          rationale:
            "If the user pushes back ('but my plan includes this!'), DO NOT argue. The entity from the backend is the source of truth for what failed; the user may be thinking of a related-but-distinct feature. Offer to share the literal backend response + ask the user to contact Followr support with the entity name.",
        },
        {
          rationale:
            "Common entities seen in practice: 'premium_images' (premium image models like gpt_image_2, nano_banana_pro), 'premium_videos' (premium video models like Veo / Seedance / Hailuo). If the entity matches one of these AND the user wants the cheaper alternative, retry with a non-premium model (nano_banana_2 for image, wan_2.2 for video). For ANY other entity name, do not invent a remediation; surface the literal entity and escalate.",
        },
      ],
    };
  }
  if (status === 422) {
    // Special case: text and audio endpoints return generic 422 with
    // `{model: ["The selected model is invalid."]}` BOTH when the model id
    // does not exist AND when the model exists but is not included in the
    // user's plan. The backend uses Laravel `Rule::in($allowed_models)` so
    // the error is structurally indistinguishable. Verified empirically
    // 2026-05-19. Reported as a gap to the Followr backend team.
    const modelInvalid = validationErrors?.["model"]?.some((m) =>
      /selected model is invalid/i.test(m),
    );
    const driverInvalid = validationErrors?.["driver"]?.some((m) =>
      /selected driver is invalid/i.test(m),
    );
    if (modelInvalid || driverInvalid) {
      const which = modelInvalid && driverInvalid ? "model and driver" : modelInvalid ? "model" : "driver";
      return {
        reason: "model_or_driver_not_available",
        user_message_override: `The ${which} value passed is not available. This is AMBIGUOUS: it may mean (a) the id does not exist on Followr, or (b) the id exists but is not included in the user's plan. The backend returns the same error for both cases. To recover: pick a known-safe default (gpt-4.1-mini + driver openai for text, nano_banana_2 + driver fal for image, elevenlabs_tts_3 + driver fal for audio) or ask the user which model they want.`,
        suggested_actions: [
          {
            tool: "get_credits_balance",
            rationale:
              "Inspect quotas. words_allowed, images_allowed > 0 means the modality is allowed at all; specific model availability is not exposed by the API today.",
          },
          {
            rationale:
              "Ask the user to open Followr UI > model selector (top header) and tell you which specific models are unlocked for their plan. There is no API endpoint that lists per-plan models.",
          },
          {
            rationale:
              "Retry with a known-safe default model: gpt-4.1-mini (text), nano_banana_2 (image), elevenlabs_tts_3 (audio), Wan 2 (video). These are available on most plans including Free.",
          },
        ],
      };
    }
    return {
      reason: "validation_failed",
      suggested_actions: [
        {
          rationale:
            "Inspect details.validation_errors to identify which field failed. Fix the input and retry.",
        },
      ],
    };
  }
  if (status === 429) {
    return {
      reason: "rate_limited",
      suggested_actions: [
        {
          rationale: "Wait a few seconds and retry. For batch operations, slow down the cadence.",
        },
      ],
    };
  }
  if (status >= 500) {
    return {
      reason: "followr_server_error",
      suggested_actions: [
        {
          rationale:
            "Transient Followr server error. Retry after a brief wait. If it persists, ask the user to check status.followr.ai or contact support.",
        },
      ],
    };
  }
  return {
    reason: "followr_api_error",
    suggested_actions: [],
  };
}
