// Generic pipeline tools.
//
// Long-running tools that opt into the async pipeline pattern (currently
// generate_avatar_video; generate_avatar_lipsync_clip and execute_content_plan
// are slated to follow) return a pipeline_id immediately and run the work
// in a background task. These tools let the agent track that work:
//   - get_pipeline_status: instant read (cheap, no polling)
//   - wait_for_pipeline: bounded poll (up to 180s, safe under any client transport)
//   - list_pipelines: recovery (find recent pipelines in a company)
//   - cancel_pipeline: request abort
//
// The tools are GENERIC: they operate on any pipeline kind (avatar_video,
// avatar_lipsync, brand_creative, ai_video_clip). The state itself carries
// the kind. This keeps the API surface small as new pipeline kinds land.

import type { FollowrClient } from "@followr-mcp/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RegisterOptions } from "../index.js";
import { MUTATION_OPEN_WORLD, READ_ONLY } from "../lib/annotations.js";
import {
  getPipeline,
  listPendingPipelines,
  listPipelinesForCompany,
  markPipelineAcknowledged,
  type PipelineState,
  requestPipelineCancellation,
} from "../lib/pipeline-state.js";
import { toolError, toolErrorFromException } from "../lib/tool-error.js";

// Serialize a PipelineState for the agent. Drops nothing; just adds a
// human-readable summary field that translates the current sub_phase to
// plain Spanish for tools the agent surfaces directly to the user.
function serializePipeline(state: PipelineState): Record<string, unknown> {
  const phaseLabelEs = humanizePhase(state.kind, state.current_sub_phase);
  const summary = buildUserFacingSummary(state, phaseLabelEs);
  return {
    pipeline_id: state.pipeline_id,
    kind: state.kind,
    company_id: state.company_id,
    execution_id: state.execution_id,
    phase: state.phase,
    current_sub_phase: state.current_sub_phase,
    progress: state.progress,
    estimated_remaining_seconds: state.estimated_remaining_seconds,
    cancel_requested: state.cancel_requested,
    sub_jobs: state.sub_jobs,
    result: state.result,
    failure: state.failure,
    created_at_ms: state.created_at_ms,
    updated_at_ms: state.updated_at_ms,
    expires_at_ms: state.expires_at_ms,
    user_facing_summary: summary,
    user_facing_phase_es: phaseLabelEs,
  };
}

// Translate the runner's free-form sub_phase into a short, user-facing
// Spanish phrase. Avatar-video phase names are the ones the runner emits
// today; other kinds will be added as their runners land.
function humanizePhase(kind: PipelineState["kind"], subPhase: string): string {
  if (subPhase.startsWith("queued")) return "en cola";
  if (subPhase.startsWith("starting")) return "arrancando";
  if (subPhase.startsWith("materialize_avatar_assets"))
    return "generando los avatares del plan";
  if (subPhase.startsWith("materializing_avatar")) return "generando un avatar";
  if (subPhase.startsWith("backgrounds")) return "generando los fondos de cada scene";
  if (subPhase.startsWith("tts")) return "generando los audios de cada scene";
  if (subPhase.startsWith("lipsync")) return "rendereando los videos del avatar (lipsync)";
  if (subPhase.startsWith("probing_durations")) return "midiendo la duración exacta de cada escena";
  if (subPhase.startsWith("concat")) return "uniendo las escenas con subtítulos";
  if (subPhase.startsWith("library_upload")) return "subiendo el video a tu Media Library";
  if (subPhase.startsWith("submitting")) return "enviando el pedido a Creative Studio";
  if (subPhase.startsWith("rendering slides")) return "rendereando los slides del creative";
  if (subPhase.startsWith("uploading slides")) return "subiendo los slides a tu Media Library";
  if (subPhase.startsWith("resolving_assets")) return "generando las imágenes y videos del plan";
  if (subPhase.startsWith("creating_post_groups")) return "creando los post groups en Followr";
  if (subPhase.startsWith("scheduling_posts")) return "calendarizando los posteos";
  if (subPhase.startsWith("executing_item:")) {
    const slug = subPhase.split(":")[1] ?? "";
    return `ejecutando el día "${slug}"`;
  }
  if (subPhase.startsWith("executing")) return "ejecutando los items del plan";
  if (subPhase === "completed") return "terminado";
  if (subPhase.startsWith("failed")) return `falló: ${subPhase}`;
  if (subPhase.startsWith("cancelled")) return `cancelado en ${subPhase}`;
  // Fallback: surface the raw sub_phase. Kind-specific runners can extend
  // the mapping above as new sub_phase labels are introduced.
  void kind;
  return subPhase;
}

function buildUserFacingSummary(state: PipelineState, phaseEs: string): string {
  switch (state.phase) {
    case "queued":
      return `Tu pieza está en cola. Va a arrancar enseguida.`;
    case "running": {
      const progressPart = state.progress
        ? ` (${state.progress.completed}/${state.progress.total})`
        : "";
      const etaPart =
        state.estimated_remaining_seconds && state.estimated_remaining_seconds > 0
          ? `, faltan ~${formatRemaining(state.estimated_remaining_seconds)}`
          : "";
      return `Sigue: ${phaseEs}${progressPart}${etaPart}.`;
    }
    case "completed": {
      const link = state.result?.asset_url ?? "";
      return `Listo. ${link ? `Acá está: ${link}` : "Tu pieza está lista."}`;
    }
    case "failed": {
      const msg = state.failure?.user_message ?? "Error desconocido";
      return `Falló: ${msg}`;
    }
    case "cancelled":
      return "Cancelado a pedido tuyo. Los jobs ya enviados al backend siguen corriendo (Followr no tiene API de abort) pero el orquestador no avanza más fases. Los créditos ya gastados no se recuperan.";
  }
}

function describeRelativeAge(hoursAgo: number): string {
  if (hoursAgo < 1) return "hace menos de una hora";
  if (hoursAgo < 24) return `hace ${hoursAgo} ${hoursAgo === 1 ? "hora" : "horas"}`;
  const days = Math.floor(hoursAgo / 24);
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return `hace más de una semana`;
}

function describePipelineKind(kind: PipelineState["kind"]): string {
  switch (kind) {
    case "avatar_video":
      return "un reel con avatar";
    case "avatar_lipsync":
      return "un clip de avatar (single-scene)";
    case "brand_creative":
      return "una pieza con Creative Studio";
    case "ai_video_clip":
      return "un video AI";
    case "content_plan_execution":
      return "un plan de contenido";
  }
}

function buildPendingPipelineIntro(
  state: PipelineState,
  completedHoursAgo: number,
): string {
  const kindLabel = describePipelineKind(state.kind);
  const ageLabel = describeRelativeAge(completedHoursAgo);
  const phaseLabel = state.phase;
  if (phaseLabel === "completed") {
    return `${ageLabel.charAt(0).toUpperCase()}${ageLabel.slice(1)} el usuario disparó ${kindLabel} y se fue mientras corría el pipeline. Recién terminó y todavía no se enteró en chat. Empezá tu primera respuesta de la sesión avisándole que está listo, resumí en una o dos líneas qué quedó publicado / generado (leé result.metadata si lo necesitás), y después llamá mark_pipeline_acknowledged(pipeline_id) para que esto no se repita en la próxima sesión.`;
  }
  if (phaseLabel === "failed") {
    const reason = state.failure?.user_message ?? "no se registró el motivo";
    return `${ageLabel.charAt(0).toUpperCase()}${ageLabel.slice(1)} el usuario disparó ${kindLabel} y se fue. El pipeline falló durante la ejecución (motivo: ${reason}). Empezá tu primera respuesta avisándole que tuvimos un problema con el flujo, qué se pudo / no se pudo terminar, y ofrecé reintentar. Después llamá mark_pipeline_acknowledged(pipeline_id).`;
  }
  if (phaseLabel === "cancelled") {
    return `${ageLabel.charAt(0).toUpperCase()}${ageLabel.slice(1)} se canceló ${kindLabel} a pedido del usuario. Si retomamos la conversación, confirmá que la cancelación se ejecutó y los créditos ya gastados no vuelven. Después llamá mark_pipeline_acknowledged(pipeline_id).`;
  }
  return `${ageLabel.charAt(0).toUpperCase()}${ageLabel.slice(1)} terminó ${kindLabel} en estado ${phaseLabel}. Resumí al usuario lo que pasó y llamá mark_pipeline_acknowledged(pipeline_id).`;
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 min" : `${minutes} min`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerPipelineTools(
  server: McpServer,
  _client: FollowrClient,
  _options: RegisterOptions,
): void {
  // ── get_pipeline_status ──────────────────────────────────────────────
  server.registerTool(
    "get_pipeline_status",
    {
      annotations: READ_ONLY,
      title: "Instantly check the status of an async pipeline (avatar video, lipsync, brand creative)",
      description: `Read the current state of a pipeline started by a long-running tool with wait:false (default for generate_avatar_video as of v0.5.0). Instant (no polling), no cost.

WHEN TO CALL: every time the user asks "fijate" / "cómo va" / "ya está?". DO NOT call in a tight loop; the user is the natural pacer. If the user explicitly says "esperá" / "quédate ahí", use wait_for_pipeline instead.

RETURNS the full pipeline state INCLUDING a ready-to-speak \`user_facing_summary\` field already translated to Spanish. Prefer surfacing that string directly over re-translating phase names. Phase values:
- queued: not started yet (rare; usually transitions to running within a tick)
- running: in progress. current_sub_phase + progress tell you where it is.
- completed: result.asset_url is populated; the asset / ai_result is ready.
- failed: failure.user_message explains what broke; ask the user before retrying (do NOT auto-retry, that burns credits).
- cancelled: the user previously called cancel_pipeline.

WHEN PIPELINE_ID IS NOT FOUND: returns reason=pipeline_id_not_found_or_expired. Most common cause: the MCP server restarted and lost in-memory state, OR the pipeline aged out (6h TTL). Recovery: call list_pipelines to see what pipelines exist for the company, or list_ai_results to find the underlying generation directly.`,
      inputSchema: {
        pipeline_id: z.string().min(1).describe("The pipeline_id returned by a generate_* tool with wait:false."),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const state = getPipeline(pipeline_id);
        if (!state) {
          return toolError({
            reason: "pipeline_id_not_found_or_expired",
            user_message: `No encontré el pipeline ${pipeline_id}. O bien el MCP server se reinició y perdió el estado in-memory, o el pipeline expiró (TTL 6h). Probá list_pipelines(company_id) para ver qué pipelines hay, o list_ai_results(company_id) para buscar el ai_result subyacente directamente.`,
            blocking: false,
            details: { pipeline_id },
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(serializePipeline(state), null, 2),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ── wait_for_pipeline ────────────────────────────────────────────────
  server.registerTool(
    "wait_for_pipeline",
    {
      annotations: READ_ONLY,
      title: "Wait up to N seconds for an async pipeline to reach a terminal state (bounded poll)",
      description: `Poll a pipeline until it reaches a terminal state (completed, failed, cancelled) or the bounded wait elapses, whichever comes first. The max wait is HARD-CAPPED at 180 seconds (3 min) to stay safely under every MCP transport timeout (claude.ai cuts at ~4 min, others at 5+ min).

WHEN TO CALL: when the user explicitly says "esperá" / "quédate ahí" / "no me hagas volver" / "contame cómo va". The tool returns either the final result (if completed in the window) OR a still_running state with the latest phase if the cap elapses.

CHAINED-NARRATION PATTERN ("stay-with-me" mode for execute_content_plan): the user wants to see live progress without leaving the chat. The right shape is short waits (max_wait_seconds=60) interleaved with a narration turn each time the tool returns. Example for a 7-day plan:

  Turn 1 (after execute_content_plan with wait:false):
    Agent: "Lo dejo en background y volvés cuando quieras, o querés que te vaya contando cómo va?"
    User: "contame"
  Turn 2:
    Agent calls wait_for_pipeline(pipeline_id, max_wait_seconds=60) → returns still_running with current_sub_phase="materialize_avatar_assets", progress={1, 3}
    Agent: "Voy generando los avatares del lunes y jueves, 1 de 3 listo." → calls wait_for_pipeline again with max_wait_seconds=60
  Turn 3:
    wait returns still_running with current_sub_phase="resolving_assets", progress={4, 14}
    Agent: "Avatares listos. Estoy generando las imágenes ahora, 4 de 14." → next wait
  ...
  Turn N (terminal):
    wait returns phase="completed", result.metadata has the executed_slugs / totals
    Agent: "Listo. Quedó todo calendarizado. Te resumo: ..."

Why this shape works: each iteration's wait is short enough that the model never blocks the WebSocket for too long, and the narration between iterations keeps claude.ai's connection alive and the user engaged. Looping with max_wait_seconds=180 silently three times in a row is the anti-pattern — the user sees a spinner for 9 min with no signal that you are doing anything. Cap at 60s per wait when narrating live; bump to 180s only when the user explicitly says "esperá callado".

SET-AND-FORGET (the default): user closes claude.ai right after the initial confirmation. The pipeline runs in Followr backend. When the user next opens a conversation, get_session_context._assistant_guidance.pending_pipelines_count is non-zero and list_pending_pipelines surfaces the summary. wait_for_pipeline is NOT used in this mode.

DO NOT call back-to-back in a loop WITHOUT narrating to the user between iterations. A silent loop wastes wall clock and feels broken. After a still_running return, ALWAYS speak the user-visible progress (current_sub_phase + progress + ETA) BEFORE the next wait.

For instant status checks (no waiting), use get_pipeline_status instead.`,
      inputSchema: {
        pipeline_id: z.string().min(1),
        max_wait_seconds: z
          .number()
          .int()
          .min(5)
          .max(180)
          .optional()
          .describe("Max seconds to wait. Hard-capped at 180. Default 180."),
        interval_seconds: z
          .number()
          .min(1)
          .max(30)
          .optional()
          .describe("Polling interval in seconds. Default 3. Lower wastes CPU; higher delays the response."),
      },
    },
    async ({ pipeline_id, max_wait_seconds, interval_seconds }) => {
      try {
        const initial = getPipeline(pipeline_id);
        if (!initial) {
          return toolError({
            reason: "pipeline_id_not_found_or_expired",
            user_message: `No encontré el pipeline ${pipeline_id}. Probá list_pipelines o list_ai_results para recuperar.`,
            blocking: false,
            details: { pipeline_id },
          });
        }
        const maxWaitMs = (max_wait_seconds ?? 180) * 1000;
        const intervalMs = (interval_seconds ?? 3) * 1000;
        const deadline = Date.now() + maxWaitMs;
        while (true) {
          const state = getPipeline(pipeline_id);
          if (!state) {
            return toolError({
              reason: "pipeline_id_evicted_mid_wait",
              user_message: `El pipeline ${pipeline_id} desapareció mientras esperábamos. Probable: el MCP server reinició. Probá list_ai_results para buscar el resultado subyacente.`,
              blocking: false,
              details: { pipeline_id },
            });
          }
          if (
            state.phase === "completed" ||
            state.phase === "failed" ||
            state.phase === "cancelled"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(serializePipeline(state), null, 2),
                },
              ],
            };
          }
          if (Date.now() >= deadline) {
            // Cap reached; return still_running snapshot.
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ...serializePipeline(state),
                      timed_out_after_seconds: Math.round(maxWaitMs / 1000),
                      _assistant_guidance: {
                        next_step: "tell_user_still_running_and_offer_options",
                        instructions:
                          "El pipeline sigue corriendo. Decile al user algo tipo: 'Llevamos N min y aún está en [phase]. ¿Esperás otro toque o querés seguir con otra cosa?'. NO entres en loop de wait_for_pipeline por tu cuenta.",
                      },
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          await sleep(intervalMs);
        }
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ── list_pipelines ───────────────────────────────────────────────────
  server.registerTool(
    "list_pipelines",
    {
      annotations: READ_ONLY,
      title: "List recent pipelines for a company (recovery / discovery)",
      description: `Returns all pipelines a company has in the in-process MCP state, sorted newest first. Use as a recovery path when the agent has lost track of pipeline_ids (e.g. after a long context window, or when the user returns to a session and asks "che, ese reel?").

NOT a substitute for list_ai_results. The pipelines store is in-memory and 6h-TTL'd; it forgets older runs and resets on MCP restart. For durable recovery of generation outputs, use list_ai_results.

PRECONDITION: company_id required. If multiple companies and the user hasn't named one, call list_companies first and ask by name.`,
      inputSchema: {
        company_id: z.number().int().positive(),
        kind: z
          .enum(["avatar_video", "avatar_lipsync", "brand_creative", "ai_video_clip", "content_plan_execution"])
          .optional()
          .describe("Filter by pipeline kind. Omit for all."),
        phase: z
          .enum(["queued", "running", "completed", "failed", "cancelled"])
          .optional()
          .describe("Filter by phase. Omit for all."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results. Default 20."),
      },
    },
    async ({ company_id, kind, phase, limit }) => {
      try {
        const results = listPipelinesForCompany(company_id, {
          ...(kind ? { kind } : {}),
          ...(phase ? { phase } : {}),
          limit: limit ?? 20,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: results.length,
                  pipelines: results.map(serializePipeline),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ── list_pending_pipelines ───────────────────────────────────────────
  server.registerTool(
    "list_pending_pipelines",
    {
      annotations: READ_ONLY,
      title: "Surface recent terminal pipelines the user has not seen in chat yet",
      description: `List pipelines that finished (completed / failed / cancelled) in the last 5 days AND were never explicitly mentioned to the user in chat. Use this to close the set-and-forget loop: the user fires a long-running plan, walks away, and comes back later (sometimes hours, sometimes days). When they open a new conversation, get_session_context._assistant_guidance.pending_pipelines_count tells you whether there is anything to surface. If it is non-zero, call this tool BEFORE your first substantive message of the session and lead with a one-line recap of what finished.

WHEN TO CALL: at the start of any conversation when get_session_context.pending_pipelines_count > 0. Optionally call again later in the same conversation if the user explicitly asks "che, qué quedó pendiente?".

PRECONDITION: company_id optional. Omit to span every company the user owns; pass company_id when the conversation is already anchored on a specific brand.
WINDOW: hard-coded 5 days from terminal_at_ms. Older pipelines drop off silently to keep the queue bounded.
ACKNOWLEDGMENT FLOW: when you mention any returned pipeline to the user, immediately call mark_pipeline_acknowledged(pipeline_id) so the next session does not surface it again. The intro_for_agent field already includes a draft opener that you can adapt verbatim.
OUTPUT: pipelines_to_surface[] sorted by terminal_at_ms desc. Each entry has the pipeline_id, kind, company_id, terminal phase, completed_at, completed_hours_ago, user_facing_summary (one line you can read verbatim) and intro_for_agent (a multi-sentence brief that contextualizes the work for the user). When the list is empty the response shape stays the same with pipelines_to_surface: [] and you do NOT need to say anything to the user.`,
      inputSchema: {
        company_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter by company. Omit to span every company the user owns."),
        max_age_days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Override the default 5-day window. Capped at 30 days."),
      },
    },
    async ({ company_id, max_age_days }) => {
      try {
        const pipelines = listPendingPipelines({
          ...(company_id !== undefined ? { company_id } : {}),
          ...(max_age_days !== undefined ? { max_age_days } : {}),
        });
        const now = Date.now();
        const surface = pipelines.map((p) => {
          const phaseLabelEs = humanizePhase(p.kind, p.current_sub_phase);
          const completedAt = p.terminal_at_ms ?? p.updated_at_ms;
          const completedHoursAgo = Math.round((now - completedAt) / (60 * 60 * 1000));
          const intro = buildPendingPipelineIntro(p, completedHoursAgo);
          return {
            pipeline_id: p.pipeline_id,
            kind: p.kind,
            company_id: p.company_id,
            phase: p.phase,
            completed_at_iso: new Date(completedAt).toISOString(),
            completed_hours_ago: completedHoursAgo,
            user_facing_summary: buildUserFacingSummary(p, phaseLabelEs),
            intro_for_agent: intro,
          };
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  pipelines_to_surface: surface,
                  count: surface.length,
                  _assistant_guidance: {
                    next_step:
                      surface.length > 0
                        ? "surface_pending_pipelines_to_user_then_ack"
                        : "no_pending_pipelines",
                    instructions:
                      surface.length > 0
                        ? "Lead your first response of the session with the intro_for_agent text adapted to natural Spanish (do NOT paste it verbatim if the wording feels mechanical). Mention every pipeline returned; the user fired them and is waiting on the outcome. After mentioning each one, call mark_pipeline_acknowledged(pipeline_id) so it does not get surfaced again next session."
                        : "Nothing to surface. Continue the conversation as usual.",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ── mark_pipeline_acknowledged ───────────────────────────────────────
  server.registerTool(
    "mark_pipeline_acknowledged",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Mark a terminal pipeline as already mentioned to the user in chat",
      description: `Record that you (the agent) mentioned this pipeline to the user. After this call list_pending_pipelines no longer returns the entry, so next session will not double-surface the same completion.

WHEN TO CALL: immediately after you tell the user about a finished pipeline (typically right after list_pending_pipelines surfaces it). One call per pipeline_id; safe to skip if you decided not to mention it (e.g. the user was not interested or the pipeline is stale from a different workflow).

RETURNS ok: true on success, ok: false with reason when the pipeline is already acked, was never terminal, or expired from in-memory state.`,
      inputSchema: {
        pipeline_id: z.string().min(1),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const accepted = markPipelineAcknowledged(pipeline_id);
        if (!accepted) {
          const state = getPipeline(pipeline_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    reason: !state
                      ? "pipeline_id_not_found_or_expired"
                      : state.acknowledged_at_ms !== null
                        ? "already_acknowledged"
                        : "not_in_terminal_phase",
                    pipeline_id,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, pipeline_id }, null, 2),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );

  // ── cancel_pipeline ──────────────────────────────────────────────────
  server.registerTool(
    "cancel_pipeline",
    {
      annotations: MUTATION_OPEN_WORLD,
      title: "Request cancellation of an in-flight pipeline (best-effort)",
      description: `Mark a pipeline as cancel-requested. The runner polls this flag between phases and aborts the orchestration when set.

LIMITATIONS:
- Sub-jobs already submitted to Followr backend KEEP RUNNING. Followr has no abort API. The orchestrator just stops monitoring them and does not proceed to the next phase. Credits already spent ARE NOT recoverable.
- Cancellation is best-effort: the runner sees the flag only at safe boundaries. If the runner is mid-phase (e.g. inside a Promise.all of 5 lipsync waits), it will complete the current phase before checking.
- Pipelines already in terminal state (completed, failed, cancelled) cannot be re-cancelled; the call returns reason=already_terminal.

USE WHEN: the user explicitly says "cancelá" / "frená esto" / "no quiero seguir". Confirm with the user that credits already spent are lost. NEVER auto-cancel a pipeline on their behalf (e.g. just because they pivoted topic mid-generation).

PRECONDITION: confirm the cancellation intent with the user in their original language. State that the credits already spent are lost.`,
      inputSchema: {
        pipeline_id: z.string().min(1),
      },
    },
    async ({ pipeline_id }) => {
      try {
        const state = getPipeline(pipeline_id);
        if (!state) {
          return toolError({
            reason: "pipeline_id_not_found_or_expired",
            user_message: `No encontré el pipeline ${pipeline_id}. Si el MCP server reinició, el state se perdió pero los jobs en Followr siguen corriendo (consultá list_ai_results).`,
            blocking: false,
            details: { pipeline_id },
          });
        }
        const accepted = requestPipelineCancellation(pipeline_id);
        if (!accepted) {
          return toolError({
            reason: "already_terminal",
            user_message: `El pipeline ${pipeline_id} ya está en estado terminal (${state.phase}) o ya tiene un cancel pendiente. Nada que cancelar.`,
            blocking: false,
            details: { pipeline_id, phase: state.phase, cancel_requested: state.cancel_requested },
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  pipeline_id,
                  user_facing_summary: `Marqué el pipeline para cancelar. El orquestador va a frenar en cuanto termine la fase actual. Los créditos ya gastados no se recuperan; los jobs ya enviados a Followr siguen corriendo del lado de ellos.`,
                  _assistant_guidance: {
                    next_step: "confirm_cancellation_to_user",
                    instructions:
                      "Avisale al user que la cancelación quedó pedida. La fase actual puede tardar unos segundos en cerrar; después el pipeline pasa a estado 'cancelled'. Recordale que los créditos ya consumidos no vuelven.",
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return toolErrorFromException(err);
      }
    },
  );
}
