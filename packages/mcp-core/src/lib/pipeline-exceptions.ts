// Exceptions thrown by pipeline executors.
//
// PipelineFailedException EXTENDS ToolErrorException so that when a
// pipeline runs in SYNC mode (wait:true) and the outer handler catches it
// via `toolErrorFromException(err)`, the structured error payload
// (reason, user_message, suggested_actions, details) is preserved instead
// of being flattened to a generic "unhandled_exception".
//
// PipelineCancelledException is a plain Error: cancellation is signaled
// by the runner and converted to markPipelineCancelled in the async
// catch; it never reaches the user as an error result.

import { ToolErrorException, toolError } from "./tool-error.js";

// Thrown by an executor when hooks.checkCancelled detects a cancel request.
// Async runner catches it and marks the pipeline state as "cancelled".
// In sync mode, the outer handler catches via toolErrorFromException which
// only knows about ToolErrorException; PipelineCancelledException would
// surface as a generic "unhandled_exception" with the message
// "Pipeline cancelled at <sub_phase>". That is acceptable because sync
// mode is opt-in (CLI/IDE only) and cancellation requires concurrent
// access to the pipeline state, which is itself an async-mode concept.
export class PipelineCancelledException extends Error {
  override readonly name = "PipelineCancelledException";
  constructor(public readonly sub_phase: string) {
    super(`Pipeline cancelled at ${sub_phase}`);
  }
}

// Thrown by an executor when a phase fails with a user-facing message.
// EXTENDS ToolErrorException so sync mode's outer
// `catch (err) { return toolErrorFromException(err); }` round-trips the
// reason / user_message / details unchanged into the agent-visible
// structured error. Async mode's runner catches PipelineFailedException
// explicitly and writes the same fields to PipelineFailure for
// get_pipeline_status to surface.
export class PipelineFailedException extends ToolErrorException {
  // Widen the literal type of name from ToolErrorException so subclasses
  // can re-tag themselves. instanceof checks rely on the prototype chain,
  // not on .name; this is purely for stacktrace / debug clarity.
  override readonly name: string = "PipelineFailedException";
  readonly sub_phase: string;
  readonly user_message: string;
  readonly details: Record<string, unknown>;
  constructor(sub_phase: string, user_message: string, details: Record<string, unknown> = {}) {
    super(
      toolError({
        reason: `pipeline_${sub_phase}_failed`,
        user_message,
        details,
      }),
    );
    this.sub_phase = sub_phase;
    this.user_message = user_message;
    this.details = details;
  }
}
