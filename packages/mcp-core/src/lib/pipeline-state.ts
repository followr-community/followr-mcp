// Generic in-process store for long-running async pipelines.
//
// Why this exists:
//   Several Followr tools (generate_avatar_video, generate_avatar_lipsync_clip,
//   generate_brand_creative for big carousels, execute_content_plan) chain
//   N expensive backend calls and can run for 5-30+ minutes. Blocking the MCP
//   transport that long fails on claude.ai (4-min WebSocket cap). The
//   pipeline pattern solves it: the tool returns immediately with a
//   pipeline_id, schedules the work as a fire-and-forget background task,
//   and the agent polls via dedicated status/wait tools.
//
// Storage is process-local. If the MCP server restarts, in-flight pipelines
// lose their orchestration state. The underlying Followr ai_results survive
// in Followr's DB and can be recovered via list_ai_results. Persisting state
// to disk is a v2 problem; this v1 accepts crash loss for simplicity.

// ── Types ──────────────────────────────────────────────────────────────────

export type PipelineKind =
  | "avatar_video"
  | "avatar_lipsync"
  | "brand_creative"
  | "ai_video_clip"
  | "content_plan_execution";

export type PipelinePhase =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface PipelineProgress {
  completed: number;
  total: number;
}

export interface PipelineResult {
  ai_result_id?: number;
  asset_id?: number;
  asset_url?: string;
  // Free-form per-kind metadata (e.g. scene_count, duration_seconds, etc.).
  metadata?: Record<string, unknown>;
}

export interface PipelineFailure {
  sub_phase: string;
  reason: string;
  user_message: string;
  details?: Record<string, unknown>;
}

export interface PipelineState {
  pipeline_id: string;
  kind: PipelineKind;
  company_id: number;
  // Set when the pipeline was spawned by execute_content_plan. Null for
  // standalone pipelines kicked off by single-tool calls.
  execution_id: string | null;

  // Lifecycle timestamps in ms since epoch.
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;

  // Status.
  phase: PipelinePhase;
  // Free-form sub-phase label for user-facing summaries. E.g.
  // "queued", "backgrounds", "tts (3/5 done)", "lipsync (2/5 done)",
  // "concat", "uploading to asset library".
  current_sub_phase: string;
  progress: PipelineProgress | null;
  // Approximate wall-clock seconds remaining. Computed by the runner;
  // re-estimated each phase transition.
  estimated_remaining_seconds: number | null;

  // Cancellation: runners poll this flag between phases and abort early
  // when set. Sub-jobs already submitted to Followr keep running on the
  // backend (no abort API there); only the orchestration is interrupted.
  cancel_requested: boolean;

  // Sub-jobs spawned during the pipeline. Keyed by phase name. Useful for
  // debugging, retries, and recovery (the ai_result_ids are durable in
  // Followr DB even if the pipeline state is lost).
  sub_jobs: Record<string, number | number[]>;

  // Terminal state payloads. Only one of these is set, matching `phase`.
  result: PipelineResult | null;
  failure: PipelineFailure | null;

  // Original params for retry / inspection. Stored as a generic record;
  // each pipeline kind defines its own param shape outside this module.
  params: Record<string, unknown>;
}

// ── Storage ────────────────────────────────────────────────────────────────

// 6 hours: long enough to survive a typical user checking back after lunch.
// Pipelines that take 30+ min plus the user looking at it 2-3 times still
// fit comfortably. After this the state is gone but Followr ai_results
// can be recovered via list_ai_results.
const PIPELINE_TTL_MS = 6 * 60 * 60 * 1000;

// Cap to prevent runaway clients from filling memory. 256 = ~50 content
// plans worth of pipelines (~5 pipelines each, on the bigger end). Oldest
// entries are evicted first when full.
const MAX_PIPELINES = 256;

const pipelines = new Map<string, PipelineState>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, p] of pipelines) {
    if (p.expires_at_ms < now) pipelines.delete(id);
  }
}

function evictOldestIfNeeded(): void {
  if (pipelines.size < MAX_PIPELINES) return;
  let oldestId: string | null = null;
  let oldestT = Infinity;
  for (const [id, entry] of pipelines) {
    if (entry.created_at_ms < oldestT) {
      oldestT = entry.created_at_ms;
      oldestId = id;
    }
  }
  if (oldestId) pipelines.delete(oldestId);
}

function genId(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `pl_${rand}`;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function createPipeline(init: {
  kind: PipelineKind;
  company_id: number;
  execution_id?: string;
  params: Record<string, unknown>;
  estimated_total_seconds?: number;
  initial_sub_phase?: string;
  initial_progress?: PipelineProgress;
}): PipelineState {
  pruneExpired();
  evictOldestIfNeeded();
  const now = Date.now();
  const state: PipelineState = {
    pipeline_id: genId(),
    kind: init.kind,
    company_id: init.company_id,
    execution_id: init.execution_id ?? null,
    created_at_ms: now,
    updated_at_ms: now,
    expires_at_ms: now + PIPELINE_TTL_MS,
    phase: "queued",
    current_sub_phase: init.initial_sub_phase ?? "queued",
    progress: init.initial_progress ?? null,
    estimated_remaining_seconds: init.estimated_total_seconds ?? null,
    cancel_requested: false,
    sub_jobs: {},
    result: null,
    failure: null,
    params: init.params,
  };
  pipelines.set(state.pipeline_id, state);
  return state;
}

export function getPipeline(pipeline_id: string): PipelineState | null {
  pruneExpired();
  return pipelines.get(pipeline_id) ?? null;
}

export function listPipelinesForCompany(
  company_id: number,
  options?: {
    kind?: PipelineKind;
    phase?: PipelinePhase;
    limit?: number;
  },
): PipelineState[] {
  pruneExpired();
  const matches: PipelineState[] = [];
  for (const p of pipelines.values()) {
    if (p.company_id !== company_id) continue;
    if (options?.kind && p.kind !== options.kind) continue;
    if (options?.phase && p.phase !== options.phase) continue;
    matches.push(p);
  }
  // Newest first.
  matches.sort((a, b) => b.created_at_ms - a.created_at_ms);
  return options?.limit ? matches.slice(0, options.limit) : matches;
}

// ── Mutations (runner-side) ────────────────────────────────────────────────

// Update phase + sub_phase + progress + ETA in one go. Idempotent.
// Returns the updated state, or null if the pipeline was evicted / cancelled
// before this update landed.
export function updatePipelinePhase(
  pipeline_id: string,
  patch: {
    phase?: PipelinePhase;
    sub_phase?: string;
    progress?: PipelineProgress | null;
    estimated_remaining_seconds?: number | null;
  },
): PipelineState | null {
  const state = pipelines.get(pipeline_id);
  if (!state) return null;
  if (patch.phase !== undefined) state.phase = patch.phase;
  if (patch.sub_phase !== undefined) state.current_sub_phase = patch.sub_phase;
  if (patch.progress !== undefined) state.progress = patch.progress;
  if (patch.estimated_remaining_seconds !== undefined) {
    state.estimated_remaining_seconds = patch.estimated_remaining_seconds;
  }
  state.updated_at_ms = Date.now();
  return state;
}

// Record ai_result_ids from a sub-phase (TTS jobs, lipsync jobs, concat).
// Useful for recovery: even if the pipeline state is later lost, the
// ai_result_ids survive in Followr DB.
export function recordPipelineSubJobs(
  pipeline_id: string,
  patch: Record<string, number | number[]>,
): void {
  const state = pipelines.get(pipeline_id);
  if (!state) return;
  Object.assign(state.sub_jobs, patch);
  state.updated_at_ms = Date.now();
}

export function markPipelineCompleted(
  pipeline_id: string,
  result: PipelineResult,
): void {
  const state = pipelines.get(pipeline_id);
  if (!state) return;
  state.phase = "completed";
  state.current_sub_phase = "completed";
  state.progress = null;
  state.estimated_remaining_seconds = 0;
  state.result = result;
  state.failure = null;
  state.updated_at_ms = Date.now();
}

export function markPipelineFailed(
  pipeline_id: string,
  failure: PipelineFailure,
): void {
  const state = pipelines.get(pipeline_id);
  if (!state) return;
  state.phase = "failed";
  state.current_sub_phase = `failed (${failure.sub_phase})`;
  state.estimated_remaining_seconds = 0;
  state.failure = failure;
  state.updated_at_ms = Date.now();
}

export function markPipelineCancelled(pipeline_id: string): void {
  const state = pipelines.get(pipeline_id);
  if (!state) return;
  state.phase = "cancelled";
  state.current_sub_phase = `cancelled at ${state.current_sub_phase}`;
  state.estimated_remaining_seconds = 0;
  state.updated_at_ms = Date.now();
}

// ── Cancellation API ───────────────────────────────────────────────────────

// Set the cancel flag. Runner polls this between phases and aborts early.
// Idempotent: re-requesting a cancellation on an already-terminal pipeline
// is a no-op. Returns true if the flag was newly set (not already cancelled
// or finished).
export function requestPipelineCancellation(pipeline_id: string): boolean {
  const state = pipelines.get(pipeline_id);
  if (!state) return false;
  if (state.phase === "completed" || state.phase === "failed" || state.phase === "cancelled") {
    return false;
  }
  if (state.cancel_requested) return false;
  state.cancel_requested = true;
  state.updated_at_ms = Date.now();
  return true;
}

export function isCancellationRequested(pipeline_id: string): boolean {
  const state = pipelines.get(pipeline_id);
  if (!state) return false;
  return state.cancel_requested;
}

// ── Test / introspection helpers (no production guarantee) ─────────────────

// Force-reset the store. Used by tests only; not exported for runtime use.
export function __resetPipelineStore(): void {
  pipelines.clear();
}
